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

/** domain / product / published entity + trait, message (+version), event spec (+version) and their schema_references edges. */
async function seedEvents(tx: Prisma.TransactionClient) {
  const user = await tx.user.findFirstOrThrow();
  const s = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const domain = await tx.domain.create({ data: { name: `evd-${s}`, slug: `evd-${s}`, tenantId: TENANT } });
  const product = await tx.product.create({ data: { domainId: domain.id, name: "Checkout", slug: `checkout-${s}` } });
  const level = { tenantId: TENANT, domainId: domain.id, productId: product.id };
  const entity = await tx.entity.create({ data: { name: "Order", slug: `order-${s}`, ...level, ownerId: user.id } });
  const version = await tx.entityVersion.create({
    data: { entityId: entity.id, major: 1, minor: 0, sequence: 1, resolvedSource: "model Order {}", fieldSnapshot: [], changeKind: "INITIAL", publishedById: user.id },
  });
  const trait = await tx.trait.create({
    data: { kind: "MESSAGE", name: `CloudEvents${s}`, tenantId: TENANT, headersEntityId: entity.id, headersEntityVersionId: version.id },
  });
  const message = await tx.message.create({
    data: { ...level, name: "OrderCreated", payloadEntityId: entity.id, payloadEntityVersionId: version.id },
  });
  const messageVersion = await tx.messageVersion.create({
    data: {
      messageId: message.id, major: 1, minor: 0, sequence: 1, resolvedSpec: { name: "OrderCreated" },
      payloadEntityVersionId: version.id, changeKind: "INITIAL", publishedById: user.id,
    },
  });
  const spec = await tx.eventSpec.create({ data: { ...level, name: "checkout-service", document: { info: { title: "x" }, servers: [], operations: [] } } });
  const specVersion = await tx.eventSpecVersion.create({
    data: {
      eventSpecId: spec.id, major: 1, minor: 0, sequence: 1, document: {}, sourceDocument: {},
      frozenChannels: [], frozenTraits: [], messageVersionIds: [messageVersion.id], changeKind: "INITIAL", publishedById: user.id,
    },
  });
  const edge = (fromKind: "MESSAGE" | "MESSAGE_VERSION" | "EVENT_SPEC" | "EVENT_SPEC_VERSION" | "TRAIT", fromId: string, role: "PAYLOAD" | "HEADERS" | "MESSAGE", toKind: "ENTITY_VERSION" | "MESSAGE_VERSION", toId: string) =>
    ({ fromKind, fromId, role, toKind, toId });
  await tx.schemaReference.createMany({
    data: [
      edge("MESSAGE", message.id, "PAYLOAD", "ENTITY_VERSION", version.id),
      edge("MESSAGE_VERSION", messageVersion.id, "PAYLOAD", "ENTITY_VERSION", version.id),
      edge("EVENT_SPEC", spec.id, "MESSAGE", "MESSAGE_VERSION", messageVersion.id),
      edge("EVENT_SPEC_VERSION", specVersion.id, "MESSAGE", "MESSAGE_VERSION", messageVersion.id),
      edge("TRAIT", trait.id, "HEADERS", "ENTITY_VERSION", version.id),
    ],
  });
  return { domain, entity, version, trait, message, messageVersion, spec, specVersion };
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

describe("events core no-delete triggers (PostgreSQL)", () => {
  it("rejects direct deletes of published message and event spec versions", async () => {
    await inRolledBackTx(async (tx) => {
      const { messageVersion } = await seedEvents(tx);
      await expect(tx.messageVersion.delete({ where: { id: messageVersion.id } })).rejects.toThrow(/cannot be deleted directly/);
    });
    await inRolledBackTx(async (tx) => {
      const { specVersion } = await seedEvents(tx);
      await expect(tx.eventSpecVersion.delete({ where: { id: specVersion.id } })).rejects.toThrow(/cannot be deleted directly/);
    });
  });

  it("allows deleting a message / event spec with its versions and removes their schema_references", async () => {
    await inRolledBackTx(async (tx) => {
      const { message, messageVersion, spec, specVersion, trait } = await seedEvents(tx);
      await tx.eventSpec.delete({ where: { id: spec.id } });
      await tx.message.delete({ where: { id: message.id } });
      expect(await tx.messageVersion.count({ where: { id: messageVersion.id } })).toBe(0);
      expect(await tx.eventSpecVersion.count({ where: { id: specVersion.id } })).toBe(0);
      const left = await tx.schemaReference.findMany({ where: { fromId: { in: [message.id, messageVersion.id, spec.id, specVersion.id, trait.id] } } });
      expect(left.map((r) => r.fromKind)).toEqual(["TRAIT"]);
    });
  });

  it("cascades with the domain and leaves no ghost schema_references", async () => {
    await inRolledBackTx(async (tx) => {
      const { domain, message, messageVersion, spec, specVersion, trait } = await seedEvents(tx);
      await tx.trait.delete({ where: { id: trait.id } });
      await tx.domain.delete({ where: { id: domain.id } });
      expect(await tx.messageVersion.count({ where: { id: messageVersion.id } })).toBe(0);
      expect(await tx.eventSpecVersion.count({ where: { id: specVersion.id } })).toBe(0);
      expect(
        await tx.schemaReference.count({ where: { fromId: { in: [message.id, messageVersion.id, spec.id, specVersion.id, trait.id] } } })
      ).toBe(0);
    });
  });
});
