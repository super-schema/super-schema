import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createMessage } from "@/services/events/message.service";
import { findUsages } from "@/services/events/usage.service";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

type Scope = Awaited<ReturnType<typeof createProductScope>>;

/**
 * `publishEntity` writes an immutable audit row into the shared dev DB per call, so the versions here are inserted
 * directly: `findUsages` reads only `EntityVersion` identity (major / minor) and the edge table.
 */
async function seedEntity(sc: Scope, name: string) {
  const entity = await sc.entity(name);
  const version = await prisma.entityVersion.create({
    data: { entityId: entity.id, major: 1, minor: 0, sequence: 1, resolvedSource: entity.typespecSource ?? "", fieldSnapshot: [], changeKind: "INITIAL", publishedById: ctx.userId },
  });
  await prisma.entity.update({ where: { id: entity.id }, data: { latestVersionId: version.id } });
  return { entity, version };
}

async function seedMessageVersion(messageId: string, payloadEntityVersionId: string) {
  const mv = await prisma.messageVersion.create({
    data: { messageId, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId, changeKind: "INITIAL", publishedById: ctx.userId },
  });
  await prisma.schemaReference.create({ data: { fromKind: "MESSAGE_VERSION", fromId: mv.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: payloadEntityVersionId } });
  return mv;
}

const summary = (rows: Array<{ label: string; isDraft: boolean; target: string }>) => rows.map((u) => [u.label, u.isDraft, u.target]);

describe("findUsages", () => {
  it("lists published uses before drafts for an entity, links them, and returns [] for a message nothing uses", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const order = await seedEntity(sc, "Order");
      const message = unwrap(await createMessage(sc.product.id, { name: `OrderCreated-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      await seedMessageVersion(message.id, order.version.id);

      const entityUses = unwrap(await findUsages({ kind: "entity", entityId: order.entity.id }, ctx, TENANT));
      expect(summary(entityUses)).toEqual([
        [`Message ${message.name} v1.0`, false, "Order v1.0"],
        [`Message ${message.name} (draft)`, true, "Order v1.0"],
      ]);
      expect(entityUses.map((u) => u.role)).toEqual(["PAYLOAD", "PAYLOAD"]);
      // No message detail route exists before the Wave 5 pages: the link is the product's Messages list.
      expect(entityUses[0].href).toBe(`/schemas/${sc.domain.slug}/${sc.product.slug}?tab=events&section=messages`);

      expect(unwrap(await findUsages({ kind: "message", messageId: message.id }, ctx, TENANT))).toEqual([]);
      const missing = await findUsages({ kind: "entity", entityId: "nope" }, ctx, TENANT);
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("returns [] for an entity that was never published (no versions to reference)", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const draftOnly = await sc.entity("Draft");
      expect(unwrap(await findUsages({ kind: "entity", entityId: draftOnly.id }, ctx, TENANT))).toEqual([]);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("shows other products' referrers (read-only, linked to their own product) and spec uses of a message", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const checkout = await createProductScope(prisma, ctx);
      const fraud = await createProductScope(prisma, ctx, "fraud");
      domainIds.push(checkout.domain.id, fraud.domain.id);
      const order = await seedEntity(checkout, "Order");
      // Fraud's message pins Checkout's Order (cross-product pins are allowed inside a tenant).
      const fraudMessage = unwrap(await createMessage(fraud.product.id, { name: `OrderSeen-${fraud.s}`, payload: { entityId: order.entity.id } }, ctx));

      const entityUses = unwrap(await findUsages({ kind: "entity", entityId: order.entity.id }, ctx, TENANT));
      expect(summary(entityUses)).toEqual([[`Message ${fraudMessage.name} (draft)`, true, "Order v1.0"]]);
      expect(entityUses[0].href).toBe(`/schemas/${fraud.domain.slug}/${fraud.product.slug}?tab=events&section=messages`);

      // A spec (draft + published version) in Fraud pins the fraud message version: "who uses this message".
      const mv = await seedMessageVersion(fraudMessage.id, order.version.id);
      const spec = await prisma.eventSpec.create({ data: { name: `fraud-spec-${fraud.s}`, document: {}, tenantId: TENANT, domainId: fraud.domain.id, productId: fraud.product.id } });
      const specVersion = await prisma.eventSpecVersion.create({
        data: {
          eventSpecId: spec.id, major: 2, minor: 0, sequence: 1, document: {}, sourceDocument: {}, frozenChannels: [], frozenTraits: [],
          messageVersionIds: [mv.id], changeKind: "INITIAL", publishedById: ctx.userId,
        },
      });
      await prisma.schemaReference.createMany({
        data: [
          { fromKind: "EVENT_SPEC", fromId: spec.id, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: mv.id, isDraft: true },
          { fromKind: "EVENT_SPEC_VERSION", fromId: specVersion.id, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: mv.id },
        ],
      });
      const messageUses = unwrap(await findUsages({ kind: "message", messageId: fraudMessage.id }, ctx, TENANT));
      expect(summary(messageUses)).toEqual([
        [`Event spec ${spec.name} v2.0`, false, `${fraudMessage.name} v1.0`],
        [`Event spec ${spec.name} (draft)`, true, `${fraudMessage.name} v1.0`],
      ]);
      expect(messageUses.every((u) => u.href === `/schemas/${fraud.domain.slug}/${fraud.product.slug}?tab=events&section=specs`)).toBe(true);
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });

  it("is tenant-scoped: a foreign tenant's subject is NOT_FOUND and its referrers never appear", async () => {
    let domainId: string | undefined;
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      foreign = await createForeignTenantFixture(prisma, ctx);
      const order = await seedEntity(sc, "Order");
      const mine = unwrap(await createMessage(sc.product.id, { name: `Mine-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));

      // Subjects of another tenant look exactly like missing ones, whichever tenant the caller is in.
      const foreignEntity = await findUsages({ kind: "entity", entityId: foreign.entity.id }, ctx, TENANT);
      expect(!foreignEntity.success && foreignEntity.error.code).toBe("NOT_FOUND");
      const foreignMessage = await findUsages({ kind: "message", messageId: foreign.message.id }, ctx, TENANT);
      expect(!foreignMessage.success && foreignMessage.error.code).toBe("NOT_FOUND");
      const fromTheOtherSide = await findUsages({ kind: "entity", entityId: order.entity.id }, ctx, foreign.tenant.id);
      expect(!fromTheOtherSide.success && fromTheOtherSide.error.code).toBe("NOT_FOUND");
      // The foreign tenant's own view of its own entity works (the scope is the tenant, not a hard-coded one).
      await prisma.schemaReference.create({
        data: { fromKind: "MESSAGE_VERSION", fromId: foreign.messageVersion.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: foreign.version.id },
      });
      expect(summary(unwrap(await findUsages({ kind: "entity", entityId: foreign.entity.id }, ctx, foreign.tenant.id)))).toEqual([
        [`Message ${foreign.message.name} v1.0`, false, "Foreign v1.0"],
      ]);

      // An edge written across the tenant boundary (should be impossible through the services) is dropped, not
      // shown and not rendered as a "(deleted)" ghost either — the foreign id never reaches the caller.
      await prisma.schemaReference.create({
        data: { fromKind: "MESSAGE_VERSION", fromId: foreign.messageVersion.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: order.version.id },
      });
      const uses = unwrap(await findUsages({ kind: "entity", entityId: order.entity.id }, ctx, TENANT));
      expect(summary(uses)).toEqual([[`Message ${mine.name} (draft)`, true, "Order v1.0"]]);
      expect(JSON.stringify(uses)).not.toContain(foreign.messageVersion.id);
      expect(JSON.stringify(uses)).not.toContain(foreign.message.name);
    } finally {
      await cleanupDomains(prisma, [domainId]);
      await foreign?.cleanup();
    }
  });

  it("tolerates ghost referrers (deleted subjects) without crashing", async () => {
    let domainId: string | undefined;
    const ghostIds: string[] = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const address = await seedEntity(sc, "Address");
      const customer = await seedEntity(sc, "Customer");
      // Customer v1.0 references Address v1.0 (FIELD edge), then Customer is deleted: ENTITY_VERSION-sourced edges
      // are not cleaned up on entity deletion (Track B gap), so the row now points at a version that no longer exists.
      const fieldEdge = await prisma.schemaReference.create({
        data: { fromKind: "ENTITY_VERSION", fromId: customer.version.id, role: "FIELD", toKind: "ENTITY_VERSION", toId: address.version.id },
      });
      ghostIds.push(fieldEdge.id);
      // An event-side ghost whose source row was removed behind the triggers' back.
      const messageGhost = await prisma.schemaReference.create({
        data: { fromKind: "MESSAGE_VERSION", fromId: `gone-${sc.s}`, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: address.version.id },
      });
      ghostIds.push(messageGhost.id);
      await prisma.entity.delete({ where: { id: customer.entity.id } });

      const uses = unwrap(await findUsages({ kind: "entity", entityId: address.entity.id }, ctx, TENANT));
      expect(summary(uses).sort()).toEqual(
        [
          [`Entity version ${customer.version.id} (deleted)`, false, "Address v1.0"],
          [`Message version gone-${sc.s} (deleted)`, false, "Address v1.0"],
        ].sort(),
      );
      expect(uses.every((u) => u.href === null)).toBe(true);
    } finally {
      await prisma.schemaReference.deleteMany({ where: { id: { in: ghostIds } } });
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("rejects malformed subjects without touching the database", async () => {
    for (const bad of [null, {}, { kind: "entity" }, { kind: "message", messageId: 3 }, { kind: "entity", entityId: "" }]) {
      const r = await findUsages(bad as never, ctx, TENANT);
      expect(!r.success && r.error.code).toBe("VALIDATION_ERROR");
    }
    const noTenant = await findUsages({ kind: "entity", entityId: "e1" }, ctx, "");
    expect(!noTenant.success && noTenant.error.code).toBe("VALIDATION_ERROR");
  });

  it("maps an unexpected database failure to a DB_ERROR Result instead of throwing", async () => {
    const broken = { ...ctx, prisma: { entity: { findFirst: () => Promise.reject(new Error("connection lost")) } } as unknown as PrismaClient };
    const r = await findUsages({ kind: "entity", entityId: "e1" }, broken, TENANT);
    expect(!r.success && r.error.code).toBe("DB_ERROR");
  });
});
