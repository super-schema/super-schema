import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createMessage, deleteMessage, updateMessage } from "@/services/events/message.service";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

const draftRefs = (fromId: string) =>
  prisma.schemaReference.findMany({ where: { fromKind: "MESSAGE", fromId }, orderBy: { role: "asc" } }).then((rows) => rows.map((r) => [r.role, r.toId, r.isDraft]));

// Wave 1 sibling Task 3 owns trait.service; this task seeds trait rows directly so it does not depend on it.
const seedMessageTrait = (domainId: string, name: string) =>
  prisma.trait.create({ data: { name, kind: "MESSAGE", tenantId: TENANT, domainId } });

describe("message service", () => {
  it("creates with default-latest pins, mirrors draft refs, re-pins and checks traits", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      const other = await createProductScope(prisma, ctx, "oth");
      domainIds.push(sc.domain.id, other.domain.id);
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const key = await sc.entity("OrderKey");
      const trait = await seedMessageTrait(sc.domain.id, `CE-${sc.s}`);
      const foreignTrait = await seedMessageTrait(other.domain.id, `CE2-${other.s}`);

      const m = unwrap(
        await createMessage(sc.product.id, {
          name: `OrderCreated-${sc.s}`,
          spec: { contentType: "avro/binary", traitIds: [trait.id] },
          payload: { entityId: order.entity.id },
          key: { entityId: key.id },
        }, ctx)
      );
      expect(m).toMatchObject({
        payload: { entityId: order.entity.id, entityVersionId: order.version.id },
        key: { entityId: key.id, entityVersionId: null },
        headers: null, hasUnpublishedChanges: true, latestVersionLabel: null,
      });
      expect(await draftRefs(m.id)).toEqual([["PAYLOAD", order.version.id, true]]);

      const unpinned = unwrap(await updateMessage(m.id, { name: m.name, spec: m.spec, payload: { entityId: order.entity.id, entityVersionId: null } }, owner, ctx));
      expect(unpinned.payload.entityVersionId).toBeNull();
      expect(unpinned.key).toBeNull();
      expect(await draftRefs(m.id)).toEqual([]);

      const badTrait = await updateMessage(m.id, { name: m.name, spec: { traitIds: [foreignTrait.id] }, payload: { entityId: order.entity.id } }, owner, ctx);
      expect(!badTrait.success && badTrait.error.code).toBe("VALIDATION_ERROR");
      expect(!badTrait.success && JSON.stringify(badTrait.error.details)).toMatch(/not visible/);

      const foreign = await updateMessage(m.id, { name: m.name, payload: { entityId: order.entity.id } }, { level: "PRODUCT", productId: other.product.id }, ctx);
      expect(!foreign.success && foreign.error.code).toBe("FORBIDDEN");
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });

  it("refuses to delete a message whose version is pinned by a published spec version", async () => {
    let domainId: string | undefined;
    let stampOfRun = "none";
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      stampOfRun = sc.s;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const m = unwrap(await createMessage(sc.product.id, { name: `OrderCreated-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      const mv = await prisma.messageVersion.create({
        data: { messageId: m.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: order.version.id, changeKind: "INITIAL", publishedById: ctx.userId },
      });
      await prisma.schemaReference.create({ data: { fromKind: "EVENT_SPEC_VERSION", fromId: `esv-${sc.s}`, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: mv.id } });

      const blocked = await deleteMessage(m.id, owner, ctx);
      expect(!blocked.success && blocked.error.code).toBe("IN_USE");

      await prisma.schemaReference.deleteMany({ where: { fromId: `esv-${sc.s}` } });
      expect(unwrap(await deleteMessage(m.id, owner, ctx))).toEqual({ id: m.id });
      expect(await prisma.messageVersion.count({ where: { id: mv.id } })).toBe(0);
    } finally {
      await prisma.schemaReference.deleteMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: `esv-${stampOfRun}` } });
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("deletes a published message through the immutable-version triggers and leaves no edges behind", async () => {
    let domainId: string | undefined;
    let stampOfRun = "none";
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      stampOfRun = sc.s;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const m = unwrap(await createMessage(sc.product.id, { name: `OrderCreated-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      const mv = await prisma.messageVersion.create({
        data: { messageId: m.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: order.version.id, changeKind: "INITIAL", publishedById: ctx.userId },
      });
      await prisma.message.update({ where: { id: m.id }, data: { latestVersionId: mv.id } });
      // A version's own pin edge plus a *draft* spec edge to it: only published (non-draft) edges block deletion.
      await prisma.schemaReference.createMany({
        data: [
          { fromKind: "MESSAGE_VERSION", fromId: mv.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: order.version.id },
          { fromKind: "EVENT_SPEC", fromId: `es-${sc.s}`, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: mv.id, isDraft: true },
        ],
      });

      expect(unwrap(await deleteMessage(m.id, owner, ctx))).toEqual({ id: m.id });
      expect(await prisma.message.count({ where: { id: m.id } })).toBe(0);
      expect(await prisma.messageVersion.count({ where: { id: mv.id } })).toBe(0);
      expect(await prisma.schemaReference.count({ where: { OR: [{ fromId: m.id }, { fromId: mv.id }, { toId: mv.id }] } })).toBe(0);
    } finally {
      await prisma.schemaReference.deleteMany({ where: { fromKind: "EVENT_SPEC", fromId: `es-${stampOfRun}` } });
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
