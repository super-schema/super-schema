import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createEventSpecVersion } from "../services/events/helpers";

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

const V2_DOCUMENT = { documentVersion: 2, info: { title: "checkout-service" } };

/** domain / product / published entity + trait, an event (+ published version) and their schema_references edges. */
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
  const spec = await tx.eventSpec.create({ data: { ...level, name: "checkout-service", document: V2_DOCUMENT } });
  const specVersion = await createEventSpecVersion(tx, {
    eventSpecId: spec.id, major: 1, minor: 0, sequence: 1, document: {}, sourceDocument: V2_DOCUMENT,
    frozenTraits: [], resolvedSpec: V2_DOCUMENT, changeKind: "INITIAL", publishedById: user.id,
  });
  await tx.schemaReference.createMany({
    data: [
      { fromKind: "EVENT_SPEC", fromId: spec.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: version.id, isDraft: true },
      { fromKind: "EVENT_SPEC_VERSION", fromId: specVersion.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: version.id, isDraft: false },
      { fromKind: "TRAIT", fromId: trait.id, role: "HEADERS", toKind: "ENTITY_VERSION", toId: version.id, isDraft: false },
    ],
  });
  return { domain, entity, version, trait, spec, specVersion };
}

beforeAll(() => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
});
afterAll(async () => prisma.$disconnect());

describe("events core schema (PostgreSQL)", () => {
  it("round-trips every events model and relation through the generated client", async () => {
    await inRolledBackTx(async (tx) => {
      const { entity, version, trait, spec, specVersion } = await seedEvents(tx);
      expect(spec.specType).toBe("asyncapi@3.0");
      expect((await tx.trait.findUniqueOrThrow({ where: { id: trait.id }, include: { headersEntityVersion: true } })).headersEntityVersion?.id).toBe(version.id);
      const reread = await tx.eventSpec.findUniqueOrThrow({ where: { id: spec.id }, include: { versions: true } });
      expect(reread.versions.map((v) => v.id)).toEqual([specVersion.id]);
      expect(reread.versions[0].resolvedSpec).toEqual(V2_DOCUMENT);
      // the legacy columns are gone from the model (and from the table once the migration is applied)
      expect(reread.versions[0]).not.toHaveProperty("frozenChannels");
      expect(reread.versions[0]).not.toHaveProperty("messageVersionIds");
      expect(entity.id).toBeTruthy();
    });
  });
});

describe("events core triggers and constraints (PostgreSQL)", () => {
  it("rejects direct deletes of a published event version", async () => {
    await inRolledBackTx(async (tx) => {
      const { specVersion } = await seedEvents(tx);
      await expect(tx.eventSpecVersion.delete({ where: { id: specVersion.id } })).rejects.toThrow(/cannot be deleted directly/);
    });
  });

  it("allows deleting an event with its versions and removes their schema_references", async () => {
    await inRolledBackTx(async (tx) => {
      const { spec, specVersion, trait } = await seedEvents(tx);
      await tx.eventSpec.delete({ where: { id: spec.id } });
      expect(await tx.eventSpecVersion.count({ where: { id: specVersion.id } })).toBe(0);
      const left = await tx.schemaReference.findMany({ where: { fromId: { in: [spec.id, specVersion.id, trait.id] } } });
      expect(left.map((r) => r.fromKind)).toEqual(["TRAIT"]);
    });
  });

  it("cascades with the domain and leaves no ghost schema_references", async () => {
    await inRolledBackTx(async (tx) => {
      const { domain, spec, specVersion, trait } = await seedEvents(tx);
      await tx.trait.delete({ where: { id: trait.id } });
      await tx.domain.delete({ where: { id: domain.id } });
      expect(await tx.eventSpec.count({ where: { id: spec.id } })).toBe(0);
      expect(await tx.eventSpecVersion.count({ where: { id: specVersion.id } })).toBe(0);
      expect(await tx.schemaReference.count({ where: { fromId: { in: [spec.id, specVersion.id, trait.id] } } })).toBe(0);
    });
  });

  it("refuses a product-level trait once the legacy catalog migration has run, and a headers entity on an OPERATION trait always", async () => {
    await inRolledBackTx(async (tx) => {
      const { domain, entity } = await seedEvents(tx);
      const product = await tx.product.findFirstOrThrow({ where: { domainId: domain.id } });
      const migrated = (await tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'traits_no_product_check'`)[0].n > 0;
      if (migrated) {
        await expect(
          tx.trait.create({ data: { kind: "MESSAGE", name: `ProductLevel${Date.now()}`, tenantId: TENANT, domainId: domain.id, productId: product.id } })
        ).rejects.toThrow(/traits_no_product_check|check constraint/i);
      }
      // a headers entity on an OPERATION trait is never allowed
      await expect(
        tx.trait.create({ data: { kind: "OPERATION", name: `OpHeaders${Date.now()}`, tenantId: TENANT, headersEntityId: entity.id } })
      ).rejects.toThrow(/traits_headers_check|check constraint/i);
    });
  });
});
