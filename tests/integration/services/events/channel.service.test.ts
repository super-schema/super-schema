import "dotenv/config"; // first: @/lib/db (pulled in by the service via withAudit) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createChannel, deleteChannel, getChannel, setChannelMessages, updateChannel } from "@/services/events/channel.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

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
});
