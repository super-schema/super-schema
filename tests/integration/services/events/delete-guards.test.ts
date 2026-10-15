import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";

const { access } = vi.hoisted(() => ({ access: { userId: "", isAdmin: true } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "session-user", email: "admin@example.test" } })) }));
vi.mock("@/lib/access-control", () => ({ resolveGlobalAdminAccess: vi.fn(async () => ({ ...access })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The actions scope every by-id row to the active tenant, which comes from a request cookie: pin it to the default tenant the fixtures use.
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => "tenant_default" }));

import { deleteDomainAction } from "@/app/(dashboard)/schemas/actions";
import { deleteProduct } from "@/services/product.service";
import { findCrossProductPins } from "@/services/events/delete-guards";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  access.userId = ctx.userId;
});
afterAll(async () => prisma.$disconnect());

type Scope = Awaited<ReturnType<typeof createProductScope>>;
const placed = (sc: Scope) => ({ tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id });

/** Rows written directly (no publish audit rows): an entity version, a channel, a trait and a published message. */
async function seedOwner(sc: Scope) {
  const entity = await sc.entity("Order");
  const version = await prisma.entityVersion.create({
    data: {
      entityId: entity.id, major: 1, minor: 0, sequence: 1, resolvedSource: entity.typespecSource ?? "", fieldSnapshot: [],
      changeKind: "INITIAL", publishedById: ctx.userId,
    },
  });
  const channel = await prisma.channel.create({ data: { name: `orders-${sc.s}`, address: "orders.v1", protocol: "kafka", format: "avro", ...placed(sc) } });
  const trait = await prisma.trait.create({ data: { name: `CloudEvents-${sc.s}`, kind: "MESSAGE", ...placed(sc) } });
  const message = await prisma.message.create({ data: { name: `OrderCreated-${sc.s}`, payloadEntityId: entity.id, payloadEntityVersionId: version.id, ...placed(sc) } });
  const messageVersion = await prisma.messageVersion.create({
    data: {
      messageId: message.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: version.id,
      changeKind: "INITIAL", publishedById: ctx.userId,
    },
  });
  await prisma.message.update({ where: { id: message.id }, data: { latestVersionId: messageVersion.id, hasUnpublishedChanges: false } });
  return { entity, version, channel, trait, message, messageVersion };
}
type Owner = Awaited<ReturnType<typeof seedOwner>>;

interface Pins {
  /** `messageVersionIds` array entries. */
  messageVersionIds?: string[];
  /** Non-draft EVENT_SPEC_VERSION -> MESSAGE_VERSION edges. */
  edgeTo?: string[];
  frozenChannels?: string[];
  frozenTraits?: string[];
}

/** An event spec with ONE published version (or several via `versions`) carrying the given pins. */
async function seedSpec(sc: Scope, name: string, pins: Pins, opts: { tenantId?: string; versions?: Array<[number, number]> } = {}) {
  const spec = await prisma.eventSpec.create({
    data: { name, document: {}, ...placed(sc), tenantId: opts.tenantId ?? TENANT },
  });
  const created: string[] = [];
  let sequence = 1;
  for (const [major, minor] of opts.versions ?? [[1, 0]]) {
    const version = await prisma.eventSpecVersion.create({
      data: {
        eventSpecId: spec.id, major, minor, sequence: sequence++, document: {}, sourceDocument: {},
        frozenChannels: (pins.frozenChannels ?? []).map((id) => ({ id, name: "frozen" })),
        frozenTraits: (pins.frozenTraits ?? []).map((id) => ({ id, name: "frozen" })),
        messageVersionIds: pins.messageVersionIds ?? [],
        changeKind: "INITIAL", publishedById: ctx.userId,
      },
    });
    created.push(version.id);
    if (pins.edgeTo?.length) {
      await prisma.schemaReference.createMany({
        data: pins.edgeTo.map((toId) => ({ fromKind: "EVENT_SPEC_VERSION" as const, fromId: version.id, role: "MESSAGE" as const, toKind: "MESSAGE_VERSION" as const, toId, isDraft: false })),
      });
    }
  }
  return { spec, versionIds: created };
}

const productExists = async (id: string) => (await prisma.product.count({ where: { id } })) === 1;
const domainExists = async (id: string) => (await prisma.domain.count({ where: { id } })) === 1;
const errorOf = async (id: string) => {
  const r = await deleteProduct(id, ctx);
  if (r.success) throw new Error("expected the delete to be blocked");
  return r.error;
};

describe("product / domain delete guards: Events assets", () => {
  it("blocks the product delete on each Events kind it owns, and the DB is untouched", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "evg");
      domainId = sc.domain.id;
      // The product's entity blocks too (long-standing rule); it is removed again below to isolate the Events kinds.
      const entity = await sc.entity("Order");

      await prisma.channel.create({ data: { name: `c-${sc.s}`, address: null, protocol: "kafka", format: "avro", ...placed(sc) } });
      expect((await errorOf(sc.product.id)).message).toBe("Delete the product's 1 entity and 1 channel before removing it");

      await prisma.entity.delete({ where: { id: entity.id } });
      expect((await errorOf(sc.product.id)).message).toBe("Delete the product's 1 channel before removing it");

      await prisma.trait.create({ data: { name: `t-${sc.s}`, kind: "MESSAGE", ...placed(sc) } });
      expect((await errorOf(sc.product.id)).message).toBe("Delete the product's 1 channel and 1 trait before removing it");

      await prisma.eventSpec.create({ data: { name: `s-${sc.s}`, document: {}, ...placed(sc) } });
      const blocked = await errorOf(sc.product.id);
      expect(blocked.code).toBe("VALIDATION_ERROR");
      expect(blocked.message).toBe("Delete the product's 1 channel, 1 trait and 1 event spec before removing it");
      expect(blocked.message).not.toMatch(/foreign key|constraint|prisma/i);

      expect(await productExists(sc.product.id)).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("blocks the product delete on a message (and counts it) without any pin involved", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "evg");
      domainId = sc.domain.id;
      const owner = await seedOwner(sc);
      const error = await errorOf(sc.product.id);
      expect(error.message).toBe("Delete the product's 1 entity, 1 channel, 1 message and 1 trait before removing it");
      // Nothing was deleted or touched by the refused delete.
      expect(await prisma.message.count({ where: { id: owner.message.id } })).toBe(1);
      expect(await productExists(sc.product.id)).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("blocks the domain delete on Events assets at both levels, including a domain-level trait", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "evg");
      domainId = sc.domain.id;

      // Domain-level trait only: blocks the DOMAIN delete, never the product delete's own trait count.
      await prisma.trait.create({ data: { name: `dt-${sc.s}`, kind: "OPERATION", tenantId: TENANT, domainId: sc.domain.id } });
      expect(await deleteDomainAction(sc.domain.id)).toEqual({
        error: "Cannot delete - 1 trait exists in this domain or its products. Move or delete it first.",
      });

      // Product-level assets count at the domain too (they carry the domainId).
      await prisma.channel.create({ data: { name: `c-${sc.s}`, address: null, protocol: "kafka", format: "avro", ...placed(sc) } });
      await prisma.eventSpec.create({ data: { name: `s-${sc.s}`, document: {}, ...placed(sc) } });
      expect(await deleteDomainAction(sc.domain.id)).toEqual({
        error: "Cannot delete - 1 channel, 1 trait and 1 event spec exist in this domain or its products. Move or delete them first.",
      });
      expect(await domainExists(sc.domain.id)).toBe(true);
      expect(await productExists(sc.product.id)).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("deletes a product that owns nothing (the guard does not over-block)", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "evg");
      domainId = sc.domain.id;
      // A sibling product's assets, a domain-level trait and tenant-wide rows are not this product's.
      const sibling = await prisma.product.create({ data: { domainId: sc.domain.id, name: `sib ${sc.s}`, slug: `sib-${sc.s}` } });
      await prisma.trait.create({ data: { name: `dt-${sc.s}`, kind: "OPERATION", tenantId: TENANT, domainId: sc.domain.id } });
      await prisma.channel.create({
        data: { name: `sc-${sc.s}`, address: null, protocol: "kafka", format: "avro", tenantId: TENANT, domainId: sc.domain.id, productId: sibling.id },
      });

      const result = await deleteProduct(sc.product.id, ctx);
      expect(result).toEqual({ success: true, data: { id: sc.product.id } });
      expect(await productExists(sc.product.id)).toBe(false);
      expect(await productExists(sibling.id)).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);
});

describe("product / domain delete guards: cross-product pins", () => {
  async function twoProducts() {
    const owner = await createProductScope(prisma, ctx, "own");
    const consumer = await createProductScope(prisma, ctx, "con");
    return { owner, consumer, assets: await seedOwner(owner) };
  }

  function expectNames(message: string, owner: Scope, consumer: Scope, assets: Owner, specName: string, versions: string) {
    expect(message).toContain(`"${specName}" (product "${consumer.product.name}", ${versions})`);
    expect(message).toContain(`Message "${assets.message.name}"`);
    expect(message).toContain(`Channel "${assets.channel.name}"`);
    expect(message).toContain(`Trait "${assets.trait.name}"`);
    expect(message).not.toContain(owner.product.name);
  }

  it("names the other product's published spec (message pin by array + edge, frozen channel and trait) on the product delete", async () => {
    const domains: string[] = [];
    try {
      const { owner, consumer, assets } = await twoProducts();
      domains.push(owner.domain.id, consumer.domain.id);
      const spec = await seedSpec(
        consumer,
        `consumer-${consumer.s}`,
        { messageVersionIds: [assets.messageVersion.id], edgeTo: [assets.messageVersion.id], frozenChannels: [assets.channel.id], frozenTraits: [assets.trait.id] },
        { versions: [[1, 0], [1, 1]] }
      );

      const error = await errorOf(owner.product.id);
      // The content counts and the pin are reported together.
      expect(error.message.startsWith("Delete the product's 1 entity, 1 channel, 1 message and 1 trait before removing it. ")).toBe(true);
      expectNames(error.message, owner, consumer, assets, spec.spec.name, "v1.0, v1.1");
      expect(error.details).toMatchObject({ eventSpecs: [{ specId: spec.spec.id, productId: consumer.product.id, versions: ["1.0", "1.1"] }] });
      expect(await productExists(owner.product.id)).toBe(true);

      // The same references block the owning DOMAIN's delete (the consumer is in another domain).
      const domainBlocked = await deleteDomainAction(owner.domain.id);
      expect(domainBlocked).toHaveProperty("error");
      expectNames((domainBlocked as { error: string }).error, owner, consumer, assets, spec.spec.name, "v1.0, v1.1");
      expect(await domainExists(owner.domain.id)).toBe(true);

      // Deleting the consumer spec clears the pin; the owner's own assets still block (counts), but the pin text is gone.
      await prisma.eventSpec.delete({ where: { id: spec.spec.id } });
      const after = await errorOf(owner.product.id);
      expect(after.message).toBe("Delete the product's 1 entity, 1 channel, 1 message and 1 trait before removing it");
      expect(after.details).toBeUndefined();
    } finally {
      await cleanupDomains(prisma, domains);
    }
  }, 90_000);

  it.each([
    ["the messageVersionIds array alone", (a: Owner) => ({ messageVersionIds: [a.messageVersion.id] }), "Message"],
    ["a non-draft schema_references edge alone", (a: Owner) => ({ edgeTo: [a.messageVersion.id] }), "Message"],
    ["a frozen channel alone", (a: Owner) => ({ frozenChannels: [a.channel.id] }), "Channel"],
    ["a frozen trait alone", (a: Owner) => ({ frozenTraits: [a.trait.id] }), "Trait"],
  ])("detects a pin recorded in %s", async (_label, pins, kind) => {
    const domains: string[] = [];
    try {
      const { owner, consumer, assets } = await twoProducts();
      domains.push(owner.domain.id, consumer.domain.id);
      await seedSpec(consumer, `consumer-${consumer.s}`, pins(assets));

      const found = await findCrossProductPins(prisma, { kind: "product", productId: owner.product.id, tenantId: TENANT });
      expect(found).toHaveLength(1);
      expect(found[0].assets.map((a) => a.kind)).toEqual([kind]);
      expect(found[0]).toMatchObject({ productId: consumer.product.id, productName: consumer.product.name, versions: ["1.0"] });
    } finally {
      await cleanupDomains(prisma, domains);
    }
  }, 60_000);

  it("ignores the owner's own specs, draft-only references and specs that reference something else", async () => {
    const domains: string[] = [];
    try {
      const { owner, consumer, assets } = await twoProducts();
      domains.push(owner.domain.id, consumer.domain.id);

      // The owning product's OWN published spec is not another product's (its asset count blocks instead).
      await seedSpec(owner, `own-${owner.s}`, { messageVersionIds: [assets.messageVersion.id], frozenChannels: [assets.channel.id] });
      // A draft spec in the other product: draft edges (EVENT_SPEC -> MESSAGE_VERSION) are not published pins.
      const draft = await prisma.eventSpec.create({ data: { name: `draft-${consumer.s}`, document: {}, ...placed(consumer) } });
      await prisma.schemaReference.create({
        data: { fromKind: "EVENT_SPEC", fromId: draft.id, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: assets.messageVersion.id, isDraft: true },
      });
      // A published spec in the other product that references only its own things.
      const unrelated = await seedOwner(consumer);
      await seedSpec(consumer, `unrelated-${consumer.s}`, {
        messageVersionIds: [unrelated.messageVersion.id], frozenChannels: [unrelated.channel.id], frozenTraits: [unrelated.trait.id],
      });

      expect(await findCrossProductPins(prisma, { kind: "product", productId: owner.product.id, tenantId: TENANT })).toEqual([]);
      // Domain scope: the owner's own spec lives in the same domain, so it is not "elsewhere" either.
      expect(await findCrossProductPins(prisma, { kind: "domain", domainId: owner.domain.id, tenantId: TENANT })).toEqual([]);
    } finally {
      await cleanupDomains(prisma, domains);
    }
  }, 90_000);

  it("a sibling product in the same domain counts as another product; for the domain delete it does not", async () => {
    const domains: string[] = [];
    try {
      const owner = await createProductScope(prisma, ctx, "own");
      domains.push(owner.domain.id);
      const assets = await seedOwner(owner);
      const sibling = await prisma.product.create({ data: { domainId: owner.domain.id, name: `sib ${owner.s}`, slug: `sib-${owner.s}` } });
      const siblingScope = { ...owner, product: sibling };
      const spec = await seedSpec(siblingScope as Scope, `sibling-${owner.s}`, { messageVersionIds: [assets.messageVersion.id] });

      const product = await findCrossProductPins(prisma, { kind: "product", productId: owner.product.id, tenantId: TENANT });
      expect(product.map((p) => p.specId)).toEqual([spec.spec.id]);
      expect(product[0].productName).toBe(sibling.name);
      // Both products go with the domain, so the sibling's spec is not a surviving referrer there.
      expect(await findCrossProductPins(prisma, { kind: "domain", domainId: owner.domain.id, tenantId: TENANT })).toEqual([]);
    } finally {
      await cleanupDomains(prisma, domains);
    }
  }, 60_000);

  it("never reads, counts or names another tenant's specs", async () => {
    const domains: string[] = [];
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      const { owner, consumer, assets } = await twoProducts();
      domains.push(owner.domain.id, consumer.domain.id);
      foreign = await createForeignTenantFixture(prisma, ctx);

      // Corrupt cross-tenant data: a foreign tenant's published spec "pins" the owner's message version / channel / trait.
      const foreignSpecPlaced = { tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id };
      const foreignSpec = await prisma.eventSpec.create({ data: { name: `foreign-spec-${foreign.s}`, document: {}, ...foreignSpecPlaced } });
      const foreignVersion = await prisma.eventSpecVersion.create({
        data: {
          eventSpecId: foreignSpec.id, major: 1, minor: 0, sequence: 1, document: {}, sourceDocument: {},
          frozenChannels: [{ id: assets.channel.id }], frozenTraits: [{ id: assets.trait.id }], messageVersionIds: [assets.messageVersion.id],
          changeKind: "INITIAL", publishedById: ctx.userId,
        },
      });
      await prisma.schemaReference.create({
        data: { fromKind: "EVENT_SPEC_VERSION", fromId: foreignVersion.id, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: assets.messageVersion.id, isDraft: false },
      });

      // Only the foreign spec references the owner: nothing from that tenant is returned or named.
      expect(await findCrossProductPins(prisma, { kind: "product", productId: owner.product.id, tenantId: TENANT })).toEqual([]);
      const onlyCounts = await errorOf(owner.product.id);
      expect(onlyCounts.message).toBe("Delete the product's 1 entity, 1 channel, 1 message and 1 trait before removing it");
      expect(onlyCounts.message).not.toContain(foreignSpec.name);
      expect(onlyCounts.message).not.toContain(foreign.product.name);

      // A same-tenant spec is named; the foreign one still is not.
      const spec = await seedSpec(consumer, `consumer-${consumer.s}`, { messageVersionIds: [assets.messageVersion.id] });
      const both = await errorOf(owner.product.id);
      expect(both.message).toContain(`"${spec.spec.name}" (product "${consumer.product.name}", v1.0)`);
      expect(both.message).not.toContain(foreignSpec.name);
      expect(both.message).not.toContain(foreign.product.name);
      expect(JSON.stringify(both.details)).not.toContain(foreign.product.id);

      // Seen from the foreign tenant, the same rows are the only ones considered.
      const mirrored = await findCrossProductPins(prisma, { kind: "product", productId: owner.product.id, tenantId: foreign.tenant.id });
      expect(mirrored.map((p) => p.specId)).toEqual([foreignSpec.id]);
    } finally {
      await foreign?.cleanup();
      await cleanupDomains(prisma, domains);
    }
  }, 90_000);
});
