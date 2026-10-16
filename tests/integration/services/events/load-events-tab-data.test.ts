import "dotenv/config"; // first: @/lib/db (pulled in by the loader) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { loadLevelTraits } from "@/features/events/workspace/load-events-tab-data";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";
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

/** A product-level trait row: the Domain / Enterprise lists must never surface it (a product has no library traits of its own). */
function seedProductTrait(scope: Scope, tag: string) {
  const at = { tenantId: TENANT, domainId: scope.domain.id, productId: scope.product.id };
  return prisma.trait.create({ data: { name: `PT-${tag}-${scope.s}`, kind: "MESSAGE", ...at } });
}

interface Fixture {
  own: Scope;
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
    foreign = await createForeignTenant(prisma, ctx);
    await run({ own, other, foreign, tenantTraits });
  } finally {
    await cleanupTenantTraits(prisma, tenantTraits);
    await cleanupDomains(prisma, domainIds);
    await foreign?.cleanup();
  }
}

describe("Domain / Enterprise trait list loader (scoping)", () => {
  it("loadLevelTraits: a domain lists its own traits and the Enterprise's, never its products' or another tenant's", () =>
    withFixture(async ({ own, other, foreign, tenantTraits }) => {
      const productTrait = await seedProductTrait(own, "dom");
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
        expect(data.inherited[0].traits.find((t) => t.id === tenantTrait.id)).toMatchObject({ kind: "OPERATION", href: `/schemas/enterprise/traits/${tenantTrait.id}` });
        for (const leaked of [productTrait.id, otherDomainTrait.id, foreignDomainTrait.id, domainTrait.id]) expect(enterprise).not.toContain(leaked);

        // Forged scope: the foreign domain under our tenant id matches nothing.
        const forged = await loadLevelTraits({ scope: { tenantId: TENANT, domainId: foreign.domain.id, productId: null }, domainSlug: "x" });
        expect(forged.own).toEqual([]);
      } finally {
        await prisma.trait.deleteMany({ where: { id: foreignDomainTrait.id } });
      }
    }), 60_000);

  it("loadLevelTraits: Enterprise lists only tenant-level traits and has no inherited groups", () =>
    withFixture(async ({ own, foreign, tenantTraits }) => {
      const productTrait = await seedProductTrait(own, "ent");
      const domainTrait = await prisma.trait.create({ data: { name: `DT-${own.s}`, kind: "MESSAGE", tenantId: TENANT, domainId: own.domain.id } });
      const tenantTrait = await prisma.trait.create({ data: { name: `TT-${own.s}`, kind: "MESSAGE", tenantId: TENANT } });
      tenantTraits.push(tenantTrait.id);
      const foreignTenantTrait = await prisma.trait.create({ data: { name: `FE-${foreign.tenant.id}`, kind: "MESSAGE", tenantId: foreign.tenant.id } });
      try {
        const data = await loadLevelTraits({ scope: { tenantId: TENANT, domainId: null, productId: null }, domainSlug: null });
        expect(data.inherited).toEqual([]);
        expect(ids(data.own)).toContain(tenantTrait.id);
        expect(data.own.find((t) => t.id === tenantTrait.id)?.href).toBe(`/schemas/enterprise/traits/${tenantTrait.id}`);
        for (const leaked of [productTrait.id, domainTrait.id, foreignTenantTrait.id]) expect(ids(data.own)).not.toContain(leaked);
        expect(ids((await loadLevelTraits({ scope: { tenantId: foreign.tenant.id, domainId: null, productId: null }, domainSlug: null })).own)).toEqual([foreignTenantTrait.id]);
      } finally {
        await prisma.trait.deleteMany({ where: { id: foreignTenantTrait.id } });
      }
    }), 60_000);
});
