import "dotenv/config"; // first: @/lib/db (pulled in by the service via withAudit) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createChannel, deleteChannel, getChannel, setChannelMessages, updateChannel } from "@/services/events/channel.service";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";
import { createForeignTenant } from "./foreign-tenant";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

const base = { address: "payments.orders.v1", protocol: "Kafka", format: "avro", spec: { bindings: { kafka: { partitions: 12 } } } };

describe("channel service", () => {
  it("creates, renames, sets allowed messages and deletes a channel", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };

      const created = unwrap(await createChannel(sc.product.id, { ...base, name: `orders-${sc.s}` }, ctx));
      expect(created).toMatchObject({
        name: `orders-${sc.s}`, protocol: "kafka", format: "avro", formatDialect: null,
        productId: sc.product.id, domainId: sc.domain.id, spec: { bindings: { kafka: { partitions: 12 } } }, allowedMessageIds: [],
      });

      const json = unwrap(await updateChannel(created.id, { ...base, name: `orders2-${sc.s}`, format: "json-schema", formatDialect: null }, owner, ctx));
      expect(json).toMatchObject({ name: `orders2-${sc.s}`, format: "json-schema", formatDialect: "draft-07" });

      const order = await sc.publishedEntity("Order");
      const message = await prisma.message.create({
        data: { name: `OrderCreated-${sc.s}`, payloadEntityId: order.entity.id, tenantId: sc.domain.tenantId, domainId: sc.domain.id, productId: sc.product.id },
      });
      expect(unwrap(await setChannelMessages(created.id, [message.id, message.id], owner, ctx)).allowedMessageIds).toEqual([message.id]);
      const unknown = await setChannelMessages(created.id, ["nope"], owner, ctx);
      expect(!unknown.success && unknown.error.code).toBe("VALIDATION_ERROR");

      expect(unwrap(await deleteChannel(created.id, owner, ctx))).toEqual({ id: created.id });
      expect((await getChannel(created.id, ctx)).success).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("rejects line conflicts, invalid profiles and writes from another product (FORBIDDEN)", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const checkout = await createProductScope(prisma, ctx, "co");
      const fraud = await createProductScope(prisma, ctx, "fr");
      domainIds.push(checkout.domain.id, fraud.domain.id);
      await checkout.entity(`Orders${checkout.s}`);

      const clash = await createChannel(checkout.product.id, { ...base, name: `orders${checkout.s}` }, ctx);
      expect(!clash.success && clash.error.code).toBe("NAME_CONFLICT");
      const badProfile = await createChannel(checkout.product.id, { ...base, name: `x-${checkout.s}`, formatDialect: "draft-07" }, ctx);
      expect(!badProfile.success && badProfile.error.code).toBe("VALIDATION_ERROR");

      const channel = unwrap(await createChannel(checkout.product.id, { ...base, name: `orders-${checkout.s}` }, ctx));
      const foreign = await updateChannel(channel.id, { ...base, name: channel.name }, { level: "PRODUCT", productId: fraud.product.id }, ctx);
      expect(!foreign.success && foreign.error.code).toBe("FORBIDDEN");
      const foreignDelete = await deleteChannel(channel.id, { level: "PRODUCT", productId: fraud.product.id }, ctx);
      expect(!foreignDelete.success && foreignDelete.error.code).toBe("FORBIDDEN");
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });

  it("setChannelMessages: cross-product accepted, cross-tenant unknown, replace / clear semantics, failures leave the set intact, updatedAt bumps", async () => {
    const domainIds: Array<string | undefined> = [];
    let foreign: Awaited<ReturnType<typeof createForeignTenant>> | undefined;
    try {
      const checkout = await createProductScope(prisma, ctx, "co");
      const fraud = await createProductScope(prisma, ctx, "fr"); // same tenant, another product
      domainIds.push(checkout.domain.id, fraud.domain.id);
      foreign = await createForeignTenant(prisma, ctx);
      const owner = { level: "PRODUCT" as const, productId: checkout.product.id };

      const makeMessage = async (sc: typeof checkout, label: string) => {
        const payload = await sc.entity(`Payload${label}`);
        return prisma.message.create({
          data: { name: `${label}-${sc.s}`, payloadEntityId: payload.id, tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id },
        });
      };
      const own1 = await makeMessage(checkout, "Own1");
      const own2 = await makeMessage(checkout, "Own2");
      const fromFraud = await makeMessage(fraud, "Fraud");

      const channel = unwrap(await createChannel(checkout.product.id, { ...base, name: `orders-${checkout.s}` }, ctx));
      const allowed = async () => unwrap(await getChannel(channel.id, ctx)).allowedMessageIds;
      const sorted = (...ids: string[]) => [...ids].sort();

      // a same-tenant message of ANOTHER product is accepted (cross-product consumption is read-only by id)
      const before = (await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })).updatedAt;
      await new Promise((r) => setTimeout(r, 20));
      const first = unwrap(await setChannelMessages(channel.id, [own1.id, fromFraud.id], owner, ctx));
      expect(first.allowedMessageIds).toEqual(sorted(own1.id, fromFraud.id));
      const after = (await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })).updatedAt;
      expect(after.getTime()).toBeGreaterThan(before.getTime());

      // replace semantics: the second call replaces the whole set
      expect(unwrap(await setChannelMessages(channel.id, [own2.id], owner, ctx)).allowedMessageIds).toEqual([own2.id]);
      expect(await allowed()).toEqual([own2.id]);

      // a message of another TENANT is rejected as unknown, and the previous set stays
      const crossTenant = await setChannelMessages(channel.id, [own1.id, foreign.message.id], owner, ctx);
      expect(!crossTenant.success && crossTenant.error.code).toBe("VALIDATION_ERROR");
      expect(!crossTenant.success && crossTenant.error.message).toContain(foreign.message.id);
      expect(!crossTenant.success && crossTenant.error.message).not.toContain(own1.id);
      expect(await allowed()).toEqual([own2.id]);

      // a failed call (unknown id mixed with valid ones) leaves the previous set intact
      const bad = await setChannelMessages(channel.id, [own1.id, "nope"], owner, ctx);
      expect(!bad.success && bad.error.code).toBe("VALIDATION_ERROR");
      expect(await allowed()).toEqual([own2.id]);

      // oversized / malformed lists fail before any write
      const tooMany = await setChannelMessages(channel.id, Array.from({ length: 201 }, (_, i) => `m${i}`), owner, ctx);
      expect(!tooMany.success && tooMany.error.code).toBe("VALIDATION_ERROR");
      const notArray = await setChannelMessages(channel.id, undefined as never, owner, ctx);
      expect(!notArray.success && notArray.error.code).toBe("VALIDATION_ERROR");
      expect(await allowed()).toEqual([own2.id]);

      // duplicates collapse; [] clears
      expect(unwrap(await setChannelMessages(channel.id, [own1.id, own1.id, own2.id, own1.id], owner, ctx)).allowedMessageIds).toEqual(sorted(own1.id, own2.id));
      expect(unwrap(await setChannelMessages(channel.id, [], owner, ctx)).allowedMessageIds).toEqual([]);
      expect(await prisma.channelMessage.count({ where: { channelId: channel.id } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, domainIds);
      await foreign?.cleanup();
    }
  });

  it("updateChannel is a full replace: omitted spec resets to {}, address null clears it; allowed messages and level columns are preserved", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const payload = await sc.entity("Payload");
      const message = await prisma.message.create({
        data: { name: `Msg-${sc.s}`, payloadEntityId: payload.id, tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id },
      });
      const full = { ...base, name: `orders-${sc.s}`, spec: { title: "Orders", summary: "s", bindings: { kafka: { partitions: 3 } } } };
      const channel = unwrap(await createChannel(sc.product.id, full, ctx));
      unwrap(await setChannelMessages(channel.id, [message.id], owner, ctx));

      const replaced = unwrap(await updateChannel(channel.id, { name: channel.name, address: null, protocol: "amqp", format: "protobuf" }, owner, ctx));
      expect(replaced).toMatchObject({
        id: channel.id, name: channel.name, address: null, protocol: "amqp", format: "protobuf", formatDialect: null, spec: {},
        tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id, allowedMessageIds: [message.id],
      });
      expect(unwrap(await getChannel(channel.id, ctx))).toEqual(replaced);

      // a rejected update (bad spec) changes nothing
      const bad = await updateChannel(channel.id, { ...full, spec: { title: 5 } as never }, owner, ctx);
      expect(!bad.success && bad.error.code).toBe("VALIDATION_ERROR");
      expect(unwrap(await getChannel(channel.id, ctx))).toEqual(replaced);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("renaming into a name used by another asset in the line is a NAME_CONFLICT (cross-kind and cross-channel); renaming to itself is allowed", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      await sc.entity(`Customer${sc.s}`);
      const a = unwrap(await createChannel(sc.product.id, { ...base, name: `a-${sc.s}` }, ctx));
      unwrap(await createChannel(sc.product.id, { ...base, name: `b-${sc.s}` }, ctx));

      const vsEntity = await updateChannel(a.id, { ...base, name: `CUSTOMER${sc.s}` }, owner, ctx);
      expect(!vsEntity.success && vsEntity.error.code).toBe("NAME_CONFLICT");
      const vsChannel = await updateChannel(a.id, { ...base, name: `B-${sc.s}` }, owner, ctx);
      expect(!vsChannel.success && vsChannel.error.code).toBe("NAME_CONFLICT");
      expect(unwrap(await getChannel(a.id, ctx)).name).toBe(`a-${sc.s}`);
      expect(unwrap(await updateChannel(a.id, { ...base, name: `A-${sc.s}` }, owner, ctx)).name).toBe(`A-${sc.s}`);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("audits successful writes (CREATE / UPDATE / DELETE) and writes nothing for a failed one", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      await sc.entity(`Taken${sc.s}`);
      const name = `orders-${sc.s}`;

      const created = unwrap(await createChannel(sc.product.id, { ...base, name }, ctx));
      // creates are audited with entityId "pending" (the id only exists afterwards), so find the row by its afterState
      const createRows = await prisma.auditLog.findMany({ where: { entityType: "Channel", action: "CREATE", afterState: { path: ["id"], equals: created.id } } });
      expect(createRows).toHaveLength(1);
      expect(createRows[0]).toMatchObject({ userId: ctx.userId, entityId: "pending" });
      expect(createRows[0].afterState).toMatchObject({ id: created.id, name });

      // failed create (line conflict with an entity) -> no new audit row carrying that attempt
      const countByName = (n: string) => prisma.auditLog.count({ where: { entityType: "Channel", afterState: { path: ["name"], equals: n } } });
      const dup = await createChannel(sc.product.id, { ...base, name }, ctx);
      expect(!dup.success && dup.error.code).toBe("NAME_CONFLICT");
      const takenName = `taken${sc.s}`;
      const clash = await createChannel(sc.product.id, { ...base, name: takenName }, ctx);
      expect(!clash.success && clash.error.code).toBe("NAME_CONFLICT");
      expect(await countByName(name)).toBe(1);
      expect(await countByName(takenName)).toBe(0);

      // update: audited with the real id and before / after state; a failed update adds nothing
      const updateRows = () => prisma.auditLog.findMany({ where: { entityType: "Channel", action: "UPDATE", entityId: created.id } });
      expect(await updateRows()).toHaveLength(0);
      const renamed = unwrap(await updateChannel(created.id, { ...base, name: `renamed-${sc.s}` }, owner, ctx));
      const afterUpdate = await updateRows();
      expect(afterUpdate).toHaveLength(1);
      expect(afterUpdate[0].beforeState).toMatchObject({ name });
      expect(afterUpdate[0].afterState).toMatchObject({ name: renamed.name });
      const failedUpdate = await updateChannel(created.id, { ...base, name: takenName }, owner, ctx);
      expect(!failedUpdate.success && failedUpdate.error.code).toBe("NAME_CONFLICT");
      const unknownOwner = await updateChannel(created.id, { ...base, name: `x-${sc.s}` }, { level: "PRODUCT", productId: "nope" }, ctx);
      expect(!unknownOwner.success && unknownOwner.error.code).toBe("NOT_FOUND");
      expect(await updateRows()).toHaveLength(1);

      // delete
      unwrap(await deleteChannel(created.id, owner, ctx));
      const deleteRows = await prisma.auditLog.findMany({ where: { entityType: "Channel", action: "DELETE", entityId: created.id } });
      expect(deleteRows).toHaveLength(1);
      const missing = await deleteChannel(created.id, owner, ctx);
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
      expect(await prisma.auditLog.count({ where: { entityType: "Channel", action: "DELETE", entityId: created.id } })).toBe(1);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
