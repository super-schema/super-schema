import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma: PrismaClient;
const TENANT = "tenant_default";
class Rollback extends Error {}

async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 30_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

beforeAll(() => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
});
afterAll(async () => prisma.$disconnect());

describe("events core schema (PostgreSQL)", () => {
  it("round-trips every events model and relation through the generated client", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await tx.user.findFirstOrThrow();
      const s = `${Date.now()}`;
      const d = await tx.domain.create({ data: { name: `ev-${s}`, slug: `ev-${s}`, tenantId: TENANT } });
      const p = await tx.product.create({ data: { domainId: d.id, name: "Checkout", slug: `checkout-${s}` } });
      const e = await tx.entity.create({
        data: { name: "Order", slug: `order-${s}`, tenantId: TENANT, domainId: d.id, productId: p.id, ownerId: user.id },
      });
      const v = await tx.entityVersion.create({
        data: { entityId: e.id, major: 1, minor: 0, sequence: 1, resolvedSource: "model Order {}", fieldSnapshot: [], changeKind: "INITIAL", publishedById: user.id },
      });
      const level = { tenantId: TENANT, domainId: d.id, productId: p.id };

      const channel = await tx.channel.create({
        data: { ...level, name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro", spec: { bindings: { kafka: { partitions: 12 } } } },
      });
      const trait = await tx.trait.create({
        data: { kind: "MESSAGE", name: `CloudEvents${s}`, tenantId: TENANT, headersEntityId: e.id, headersEntityVersionId: v.id },
      });
      const message = await tx.message.create({
        data: { ...level, name: "OrderCreated", payloadEntityId: e.id, payloadEntityVersionId: v.id, spec: { traitIds: [trait.id] } },
      });
      await tx.channelMessage.create({ data: { channelId: channel.id, messageId: message.id } });
      const mv = await tx.messageVersion.create({
        data: {
          messageId: message.id, major: 1, minor: 0, sequence: 1, resolvedSpec: { name: "OrderCreated" },
          payloadEntityVersionId: v.id, changeKind: "INITIAL", publishedById: user.id,
        },
      });
      await tx.message.update({ where: { id: message.id }, data: { latestVersionId: mv.id, hasUnpublishedChanges: false } });
      const spec = await tx.eventSpec.create({
        data: { ...level, name: "checkout-service", document: { info: { title: "checkout-service" }, servers: [], operations: [] } },
      });
      expect(spec.specType).toBe("asyncapi@3.0");
      const sv = await tx.eventSpecVersion.create({
        data: {
          eventSpecId: spec.id, major: 1, minor: 0, sequence: 1, document: { asyncapi: "3.0.0" }, sourceDocument: {},
          frozenChannels: [], frozenTraits: [], messageVersionIds: [mv.id], changeKind: "INITIAL", publishedById: user.id,
        },
      });

      const reread = await tx.message.findUniqueOrThrow({
        where: { id: message.id },
        include: { latestVersion: true, channels: true, payloadEntityVersion: true },
      });
      expect(reread.latestVersion?.id).toBe(mv.id);
      expect(reread.channels).toHaveLength(1);
      expect(reread.payloadEntityVersion?.id).toBe(v.id);
      expect((await tx.eventSpecVersion.findUniqueOrThrow({ where: { id: sv.id } })).messageVersionIds).toEqual([mv.id]);
      expect((await tx.trait.findUniqueOrThrow({ where: { id: trait.id }, include: { headersEntityVersion: true } })).headersEntityVersion?.id).toBe(v.id);
    });
  });
});
