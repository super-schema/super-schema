import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createEventSpec, deleteEventSpec, renameEventSpec, updateEventSpecDocument } from "@/services/events/event-spec.service";
import { createMessage } from "@/services/events/message.service";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("event spec service", () => {
  it("validates references, accepts cross-product channels + versions and own drafts, mirrors EVENT_SPEC refs", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const checkout = await createProductScope(prisma, ctx, "co");
      const fraud = await createProductScope(prisma, ctx, "fr");
      domainIds.push(checkout.domain.id, fraud.domain.id);
      const order = await checkout.publishedEntity("Order");
      // Wave 1 sibling Task 3 owns channel.service; this task seeds the channel row directly so it does not depend on it.
      const channel = await prisma.channel.create({
        data: {
          name: `orders-${checkout.s}`, address: "payments.orders.v1", protocol: "kafka", format: "avro",
          tenantId: TENANT, domainId: checkout.domain.id, productId: checkout.product.id,
        },
      });
      const msg = unwrap(await createMessage(checkout.product.id, { name: `OrderCreated-${checkout.s}`, payload: { entityId: order.entity.id } }, ctx));
      const mv = await prisma.messageVersion.create({
        data: { messageId: msg.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: order.version.id, changeKind: "INITIAL", publishedById: ctx.userId },
      });

      const spec = unwrap(await createEventSpec(fraud.product.id, { name: `fraud-scorer-${fraud.s}`, title: "fraud-scorer" }, ctx));
      expect(spec).toMatchObject({ specType: "asyncapi@3.0", document: { info: { title: "fraud-scorer" }, servers: [], operations: [] }, hasUnpublishedChanges: true });
      const owner = { level: "PRODUCT" as const, productId: fraud.product.id };

      const unknown = await updateEventSpecDocument(spec.id, {
        info: { title: "fraud-scorer" }, servers: [],
        operations: [{ key: "consume", action: "receive", channelId: "nope", messageVersionIds: [msg.id], traitIds: ["t-missing"] }],
      }, owner, ctx);
      expect(!unknown.success && (unknown.error.details as { problems: unknown[] }).problems).toEqual([
        { pointer: "/operations/0/channelId", message: 'Channel "nope" not found' },
        { pointer: "/operations/0/messageVersionIds/0", message: `"${msg.id}" is neither a message version nor a message draft of this product` },
        { pointer: "/operations/0/traitIds/0", message: 'Trait "t-missing" not found' },
      ]);

      const saved = unwrap(await updateEventSpecDocument(spec.id, {
        info: { title: "fraud-scorer" }, servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka:9092" }],
        operations: [{ key: "consumeOrderCreated", action: "receive", channelId: channel.id, messageVersionIds: [mv.id], traitIds: [] }],
      }, owner, ctx));
      expect(saved.document.operations[0].channelId).toBe(channel.id);
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: spec.id } });
      expect(refs.map((r) => [r.role, r.toKind, r.toId, r.isDraft])).toEqual([["MESSAGE", "MESSAGE_VERSION", mv.id, true]]);

      const checkoutSpec = unwrap(await createEventSpec(checkout.product.id, { name: `checkout-service-${checkout.s}` }, ctx));
      const withDraft = await updateEventSpecDocument(checkoutSpec.id, {
        info: { title: "checkout-service" }, servers: [],
        operations: [{ key: "publish", action: "send", channelId: channel.id, messageVersionIds: [msg.id], traitIds: [] }],
      }, { level: "PRODUCT", productId: checkout.product.id }, ctx);
      expect(withDraft.success).toBe(true);
      expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: checkoutSpec.id } })).toBe(0);

      const renamed = unwrap(await renameEventSpec(spec.id, `fraud-scorer-v2-${fraud.s}`, owner, ctx));
      expect(renamed.name).toBe(`fraud-scorer-v2-${fraud.s}`);
      expect(unwrap(await deleteEventSpec(spec.id, owner, ctx))).toEqual({ id: spec.id });
      expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: spec.id } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });

  it("deletes a published spec through the immutable-version triggers and leaves no edges behind", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const spec = unwrap(await createEventSpec(sc.product.id, { name: `published-${sc.s}` }, ctx));
      const version = await prisma.eventSpecVersion.create({
        data: {
          eventSpecId: spec.id, major: 1, minor: 0, sequence: 1, document: {}, sourceDocument: {}, frozenChannels: [], frozenTraits: [],
          messageVersionIds: [], changeKind: "INITIAL", publishedById: ctx.userId,
        },
      });
      await prisma.eventSpec.update({ where: { id: spec.id }, data: { latestVersionId: version.id } });
      await prisma.schemaReference.create({
        data: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: `mv-${sc.s}` },
      });

      expect(unwrap(await deleteEventSpec(spec.id, owner, ctx))).toEqual({ id: spec.id });
      expect(await prisma.eventSpec.count({ where: { id: spec.id } })).toBe(0);
      expect(await prisma.eventSpecVersion.count({ where: { id: version.id } })).toBe(0);
      expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("rejects an invalid document, a foreign owner and a name that is taken in the line", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const a = await createProductScope(prisma, ctx, "ea");
      const b = await createProductScope(prisma, ctx, "eb");
      domainIds.push(a.domain.id, b.domain.id);
      const ownerA = { level: "PRODUCT" as const, productId: a.product.id };
      const spec = unwrap(await createEventSpec(a.product.id, { name: `one-${a.s}` }, ctx));
      const other = unwrap(await createEventSpec(a.product.id, { name: `two-${a.s}` }, ctx));

      const invalid = await updateEventSpecDocument(spec.id, { info: {}, servers: [], operations: [] }, ownerA, ctx);
      expect(!invalid.success && invalid.error.code).toBe("VALIDATION_ERROR");
      expect(!invalid.success && JSON.stringify(invalid.error.details)).toMatch(/\/info\/title/);

      const foreign = await updateEventSpecDocument(spec.id, spec.document, { level: "PRODUCT", productId: b.product.id }, ctx);
      expect(!foreign.success && foreign.error.code).toBe("FORBIDDEN");
      const foreignDelete = await deleteEventSpec(spec.id, { level: "PRODUCT", productId: b.product.id }, ctx);
      expect(!foreignDelete.success && foreignDelete.error.code).toBe("FORBIDDEN");

      const taken = await renameEventSpec(spec.id, other.name, ownerA, ctx);
      expect(!taken.success && taken.error.code).toBe("NAME_CONFLICT");
      const badName = await createEventSpec(a.product.id, { name: "has space" }, ctx);
      expect(!badName.success && badName.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });
});
