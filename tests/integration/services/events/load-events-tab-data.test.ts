import "dotenv/config"; // first: @/lib/db (pulled in by the loaders) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { loadLevelTraits, loadProductEventsData } from "@/features/events/workspace/load-events-tab-data";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createProductScope, stamp, TENANT, testContext } from "./helpers";
import { createForeignTenant } from "./foreign-tenant";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);

type Scope = Awaited<ReturnType<typeof createProductScope>>;
type Foreign = Awaited<ReturnType<typeof createForeignTenant>>;

/** One of each product-level row (an unpublished entity is enough as a payload, and writes no audit rows). */
async function seedProduct(scope: Scope, tag: string) {
  const at = { tenantId: TENANT, domainId: scope.domain.id, productId: scope.product.id };
  const entity = await scope.entity(`Order${tag}${scope.s}`);
  const message = await prisma.message.create({ data: { name: `Msg-${tag}-${scope.s}`, payloadEntityId: entity.id, ...at } });
  const channel = await prisma.channel.create({ data: { name: `ch-${tag}-${scope.s}`, address: `t.${tag}`, protocol: "kafka", format: "avro", ...at } });
  const spec = await prisma.eventSpec.create({ data: { name: `spec-${tag}-${scope.s}`, document: { info: { title: tag }, operations: [{}, {}] }, ...at } });
  const trait = await prisma.trait.create({ data: { name: `PT-${tag}-${scope.s}`, kind: "MESSAGE", ...at } });
  return { entity, message, channel, spec, trait };
}

interface Fixture {
  own: Scope;
  /** Another product of the SAME domain. */
  sibling: Scope["product"];
  /** A product line of another domain in the same tenant. */
  other: Scope;
  foreign: Foreign;
  /** Tenant-level traits created by the test; deleted in `finally`. */
  tenantTraits: string[];
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const domainIds: string[] = [];
  const tenantTraits: string[] = [];
  let foreign: Foreign | undefined;
  try {
    const own = await createProductScope(prisma, ctx, "lt");
    const other = await createProductScope(prisma, ctx, "lu");
    domainIds.push(own.domain.id, other.domain.id);
    // A second product inside the first one's domain (createProductScope always makes a fresh domain).
    const siblingProduct = await prisma.product.create({ data: { domainId: own.domain.id, name: `sibling ${own.s}`, slug: `sib-${own.s}` } });
    foreign = await createForeignTenant(prisma, ctx);
    await run({ own, sibling: siblingProduct, other, foreign, tenantTraits });
  } finally {
    await cleanupTenantTraits(prisma, tenantTraits);
    await cleanupDomains(prisma, domainIds);
    await foreign?.cleanup();
  }
}

describe("workspace tab loaders (scoping)", () => {
  it("loadProductEventsData: only this product's events, own / domain / Enterprise traits, canonical links", () =>
    withFixture(async ({ own, sibling, other, foreign, tenantTraits }) => {
      const mine = await seedProduct(own, "own");
      const sibEntity = await prisma.entity.create({
        data: {
          name: `Sib${own.s}`, slug: `sib-${own.s}`, tenantId: TENANT, domainId: own.domain.id, productId: sibling.id,
          ownerId: ctx.userId, typespecSource: "model Sib {\n  id: string;\n}\n",
        },
      });
      const sibAt = { tenantId: TENANT, domainId: own.domain.id, productId: sibling.id };
      const sibChannel = await prisma.channel.create({ data: { name: `ch-sib-${own.s}`, protocol: "kafka", format: "avro", ...sibAt } });
      const sibSpec = await prisma.eventSpec.create({ data: { name: `spec-sib-${own.s}`, document: {}, ...sibAt } });
      const sibMessage = await prisma.message.create({ data: { name: `Msg-sib-${own.s}`, payloadEntityId: sibEntity.id, ...sibAt } });
      const sibTrait = await prisma.trait.create({ data: { name: `PT-sib-${own.s}`, kind: "MESSAGE", ...sibAt } });
      const elsewhere = await seedProduct(other, "oth");
      const domainTrait = await prisma.trait.create({ data: { name: `DT-${own.s}`, kind: "OPERATION", tenantId: TENANT, domainId: own.domain.id } });
      const tenantTrait = await prisma.trait.create({ data: { name: `TT-${own.s}`, kind: "MESSAGE", tenantId: TENANT } });
      tenantTraits.push(tenantTrait.id);
      const foreignTrait = await prisma.trait.create({
        data: { name: `FT-${foreign.tenant.id}`, kind: "MESSAGE", tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id },
      });
      try {
        const { events, traits } = await loadProductEventsData({
          tenantId: TENANT, domainId: own.domain.id, productId: own.product.id, domainSlug: own.domain.slug, productSlug: own.product.slug,
        });
        const at = `/schemas/${own.domain.slug}/${own.product.slug}`;

        expect(ids(events.eventSpecs)).toEqual([mine.spec.id]);
        expect(events.eventSpecs[0]).toMatchObject({
          name: mine.spec.name, summary: "", latestVersionLabel: null, hasUnpublishedChanges: true, operationCount: 2, href: `${at}/specs/${mine.spec.id}`,
        });
        expect(ids(events.messages)).toEqual([mine.message.id]);
        expect(events.messages[0]).toMatchObject({ payloadEntityName: mine.entity.name, href: `${at}/messages/${mine.message.id}` });
        expect(ids(events.channels)).toEqual([mine.channel.id]);
        expect(events.channels[0]).toMatchObject({ address: "t.own", protocol: "kafka", format: "avro", href: `${at}/channels/${mine.channel.id}` });
        for (const leaked of [sibSpec.id, sibMessage.id, sibChannel.id, elsewhere.spec.id, elsewhere.message.id, elsewhere.channel.id, foreign.message.id]) {
          expect([...ids(events.eventSpecs), ...ids(events.messages), ...ids(events.channels)]).not.toContain(leaked);
        }

        // Payload options: every entity of the tenant, none of another tenant's.
        expect(ids(events.payloadEntities)).toEqual(expect.arrayContaining([mine.entity.id, sibEntity.id, elsewhere.entity.id]));
        expect(ids(events.payloadEntities)).not.toContain(foreign.entity.id);

        expect(ids(traits.own)).toEqual([mine.trait.id]);
        expect(traits.own[0].href).toBe(`${at}/traits/${mine.trait.id}`);
        expect(traits.inherited.map((g) => g.label)).toEqual(["From Domain", "From Enterprise"]);
        const [fromDomain, fromEnterprise] = traits.inherited;
        expect(fromDomain.href).toBe(`/schemas/${own.domain.slug}?tab=traits`);
        expect(ids(fromDomain.traits)).toEqual([domainTrait.id]);
        expect(fromDomain.traits[0]).toMatchObject({ kind: "OPERATION", href: `/schemas/${own.domain.slug}/traits/${domainTrait.id}` });
        expect(fromEnterprise.href).toBe("/schemas/enterprise?tab=traits");
        expect(ids(fromEnterprise.traits)).toContain(tenantTrait.id);
        expect(fromEnterprise.traits.find((t) => t.id === tenantTrait.id)?.href).toBe(`/schemas/enterprise/traits/${tenantTrait.id}`);
        const allTraitIds = [...ids(traits.own), ...ids(fromDomain.traits), ...ids(fromEnterprise.traits)];
        for (const leaked of [sibTrait.id, elsewhere.trait.id, foreignTrait.id]) expect(allTraitIds).not.toContain(leaked);
      } finally {
        await prisma.trait.deleteMany({ where: { id: foreignTrait.id } });
      }
    }), 60_000);

  it("loadProductEventsData: a forged product / domain id from another tenant surfaces none of its rows", () =>
    withFixture(async ({ foreign }) => {
      const { events, traits } = await loadProductEventsData({
        tenantId: TENANT, domainId: foreign.domain.id, productId: foreign.product.id, domainSlug: "x", productSlug: "y",
      });
      expect(events).toMatchObject({ eventSpecs: [], messages: [], channels: [] });
      expect(traits.own).toEqual([]);
      expect(ids(events.payloadEntities)).not.toContain(foreign.entity.id);
    }), 60_000);

  it("loadProductEventsData: a product with no traits anywhere above it has no inherited groups", async () => {
    const s = stamp();
    const emptyTenant = await prisma.tenant.create({ data: { name: `et-${s}`, slug: `et-${s}` } });
    try {
      // The tenant delete cascades to the domain and product (no edge rows exist for them).
      const domain = await prisma.domain.create({ data: { name: `et-${s}`, slug: `et-${s}`, tenantId: emptyTenant.id } });
      const product = await prisma.product.create({ data: { domainId: domain.id, name: `et ${s}`, slug: `et-p-${s}` } });
      const { events, traits } = await loadProductEventsData({
        tenantId: emptyTenant.id, domainId: domain.id, productId: product.id, domainSlug: domain.slug, productSlug: product.slug,
      });
      expect(traits).toEqual({ own: [], inherited: [] });
      expect(events).toEqual({ eventSpecs: [], messages: [], channels: [], payloadEntities: [] });
    } finally {
      await prisma.tenant.deleteMany({ where: { id: emptyTenant.id } });
    }
  }, 60_000);

  it("loadLevelTraits: a domain lists its own traits and the Enterprise's, never its products' or another tenant's", () =>
    withFixture(async ({ own, other, foreign, tenantTraits }) => {
      const mine = await seedProduct(own, "dom");
      const domainTrait = await prisma.trait.create({ data: { name: `DT-${own.s}`, kind: "MESSAGE", tenantId: TENANT, domainId: own.domain.id } });
      const otherDomainTrait = await prisma.trait.create({ data: { name: `OD-${own.s}`, kind: "MESSAGE", tenantId: TENANT, domainId: other.domain.id } });
      const tenantTrait = await prisma.trait.create({ data: { name: `TT-${own.s}`, kind: "OPERATION", tenantId: TENANT } });
      tenantTraits.push(tenantTrait.id);
      const foreignDomainTrait = await prisma.trait.create({ data: { name: `FD-${foreign.tenant.id}`, kind: "MESSAGE", tenantId: foreign.tenant.id, domainId: foreign.domain.id } });
      try {
        const data = await loadLevelTraits({ scope: { tenantId: TENANT, domainId: own.domain.id, productId: null }, domainSlug: own.domain.slug });
        expect(ids(data.own)).toEqual([domainTrait.id]);
        expect(data.own[0].href).toBe(`/schemas/${own.domain.slug}/traits/${domainTrait.id}`);
        expect(data.inherited.map((g) => [g.label, g.href])).toEqual([["From Enterprise", "/schemas/enterprise?tab=traits"]]);
        const enterprise = ids(data.inherited[0].traits);
        expect(enterprise).toContain(tenantTrait.id);
        for (const leaked of [mine.trait.id, otherDomainTrait.id, foreignDomainTrait.id, domainTrait.id]) expect(enterprise).not.toContain(leaked);

        // Forged scope: the foreign domain under our tenant id matches nothing.
        const forged = await loadLevelTraits({ scope: { tenantId: TENANT, domainId: foreign.domain.id, productId: null }, domainSlug: "x" });
        expect(forged.own).toEqual([]);
      } finally {
        await prisma.trait.deleteMany({ where: { id: foreignDomainTrait.id } });
      }
    }), 60_000);

  it("loadLevelTraits: Enterprise lists only tenant-level traits and has no inherited groups", () =>
    withFixture(async ({ own, foreign, tenantTraits }) => {
      const mine = await seedProduct(own, "ent");
      const domainTrait = await prisma.trait.create({ data: { name: `DT-${own.s}`, kind: "MESSAGE", tenantId: TENANT, domainId: own.domain.id } });
      const tenantTrait = await prisma.trait.create({ data: { name: `TT-${own.s}`, kind: "MESSAGE", tenantId: TENANT } });
      tenantTraits.push(tenantTrait.id);
      const foreignTenantTrait = await prisma.trait.create({ data: { name: `FE-${foreign.tenant.id}`, kind: "MESSAGE", tenantId: foreign.tenant.id } });
      try {
        const data = await loadLevelTraits({ scope: { tenantId: TENANT, domainId: null, productId: null }, domainSlug: null });
        expect(data.inherited).toEqual([]);
        expect(ids(data.own)).toContain(tenantTrait.id);
        expect(data.own.find((t) => t.id === tenantTrait.id)?.href).toBe(`/schemas/enterprise/traits/${tenantTrait.id}`);
        for (const leaked of [mine.trait.id, domainTrait.id, foreignTenantTrait.id]) expect(ids(data.own)).not.toContain(leaked);
        expect(ids((await loadLevelTraits({ scope: { tenantId: foreign.tenant.id, domainId: null, productId: null }, domainSlug: null })).own)).toEqual([foreignTenantTrait.id]);
      } finally {
        await prisma.trait.deleteMany({ where: { id: foreignTenantTrait.id } });
      }
    }), 60_000);
});
