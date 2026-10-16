import "dotenv/config"; // first: @/lib/db (pulled in by the loaders) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";

const h = vi.hoisted(() => ({ getActiveTenantId: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));

import { loadTraitPage } from "@/features/events/traits/load-trait-page";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());
beforeEach(() => h.getActiveTenantId.mockResolvedValue(TENANT));

type Own = Awaited<ReturnType<typeof createProductScope>>;
type Foreign = Awaited<ReturnType<typeof createForeignTenantFixture>>;

interface Fixture {
  own: Own;
  /** A second product line in the same tenant (its own domain). */
  other: Own;
  foreign: Foreign;
  traitTenant: { id: string; name: string };
  traitDomain: { id: string; name: string };
  traitOtherDomain: { id: string; name: string };
}

/** Builds two product lines in the active tenant plus a whole foreign tenant, runs one body, and removes everything. */
async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const domainIds: string[] = [];
  const tenantTraits: string[] = [];
  let foreign: Foreign | undefined;
  try {
    const own = await createProductScope(prisma, ctx, "pg");
    const other = await createProductScope(prisma, ctx, "pq");
    domainIds.push(own.domain.id, other.domain.id);
    foreign = await createForeignTenantFixture(prisma, ctx);
    const trait = (name: string, where: { domainId: string | null; productId: string | null }) =>
      prisma.trait.create({ data: { name, kind: "MESSAGE", tenantId: TENANT, ...where }, select: { id: true, name: true } });

    const traitTenant = await trait(`te-${own.s}`, { domainId: null, productId: null });
    tenantTraits.push(traitTenant.id);
    await run({
      own, other, foreign,
      traitTenant,
      traitDomain: await trait(`td-${own.s}`, { domainId: own.domain.id, productId: null }),
      traitOtherDomain: await trait(`tq-${other.s}`, { domainId: other.domain.id, productId: null }),
    });
  } finally {
    await cleanupTenantTraits(prisma, tenantTraits);
    await cleanupDomains(prisma, domainIds);
    await foreign?.cleanup();
  }
}

const route = (s: Own) => ({ domainSlug: s.domain.slug, productSlug: s.product.slug });

describe("loadTraitPage (tenant + level scoped by-id read)", () => {
  it("loads a trait only under its own level's route, with that level's owner target, list link and crumbs", async () => {
    await withFixture(async (f) => {
      const enterprise = await loadTraitPage({ domainSlug: null, productSlug: null, traitId: f.traitTenant.id });
      expect(enterprise?.owner).toEqual({ level: "TENANT", tenantId: TENANT });
      expect(enterprise?.listHref).toBe("/schemas/enterprise?tab=traits");
      expect(enterprise?.crumbs.map((c) => c.label)).toEqual(["Enterprise", "Message properties", f.traitTenant.name]);

      const domain = await loadTraitPage({ domainSlug: f.own.domain.slug, productSlug: null, traitId: f.traitDomain.id });
      expect(domain?.owner).toEqual({ level: "DOMAIN", domainId: f.own.domain.id });
      expect(domain?.listHref).toBe(`/schemas/${f.own.domain.slug}?tab=traits`);
      expect(domain?.crumbs.map((c) => c.label)).toEqual(["Domains", f.own.domain.name, "Message properties", f.traitDomain.name]);
      expect(domain?.trait).toMatchObject({ id: f.traitDomain.id, kind: "MESSAGE", headers: null });
      expect(Array.isArray(domain?.entityOptions)).toBe(true);

    });
  });

  it("404s (null) when the trait is addressed through any other level or product", async () => {
    await withFixture(async (f) => {
      const domainRoute = { domainSlug: f.own.domain.slug, productSlug: null };
      const enterpriseRoute = { domainSlug: null, productSlug: null };
      expect(await loadTraitPage({ ...enterpriseRoute, traitId: f.traitDomain.id })).toBeNull();
      expect(await loadTraitPage({ ...domainRoute, traitId: f.traitTenant.id })).toBeNull();
      expect(await loadTraitPage({ ...route(f.own), traitId: f.traitDomain.id })).toBeNull();
      expect(await loadTraitPage({ ...route(f.own), traitId: f.traitTenant.id })).toBeNull();
      expect(await loadTraitPage({ ...route(f.own), traitId: f.traitOtherDomain.id })).toBeNull();
      expect(await loadTraitPage({ ...domainRoute, traitId: f.traitOtherDomain.id })).toBeNull();
      expect(await loadTraitPage({ domainSlug: f.other.domain.slug, productSlug: null, traitId: f.traitDomain.id })).toBeNull();
    });
  });

  it("404s for another tenant's traits (same as an unknown id), at every level", async () => {
    await withFixture(async (f) => {
      expect(await loadTraitPage({ domainSlug: null, productSlug: null, traitId: f.foreign.trait.id })).toBeNull();
      expect(await loadTraitPage({ domainSlug: null, productSlug: null, traitId: "t-does-not-exist" })).toBeNull();
      expect(await loadTraitPage({ ...route(f.own), traitId: f.foreign.trait.id })).toBeNull();
      expect(await loadTraitPage({ domainSlug: f.foreign.domain.slug, productSlug: null, traitId: f.foreign.trait.id })).toBeNull();
      // The same enterprise trait is invisible once the active tenant is the other one, and vice versa.
      h.getActiveTenantId.mockResolvedValue(f.foreign.tenant.id);
      expect(await loadTraitPage({ domainSlug: null, productSlug: null, traitId: f.traitTenant.id })).toBeNull();
      expect((await loadTraitPage({ domainSlug: null, productSlug: null, traitId: f.foreign.trait.id }))?.trait.id).toBe(f.foreign.trait.id);
    });
  });

  it("404s for a product slug without a domain slug (not a URL the routes produce)", async () => {
    await withFixture(async (f) => {
      expect(await loadTraitPage({ domainSlug: null, productSlug: f.own.product.slug, traitId: f.traitTenant.id })).toBeNull();
    });
  });
});
