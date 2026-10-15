import "dotenv/config"; // first: @/lib/db (pulled in by the loaders) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";

const h = vi.hoisted(() => ({ getActiveTenantId: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));

import { loadChannelPage } from "@/features/events/channels/load-channel-page";
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
  channelOwn: { id: string; name: string };
  channelOther: { id: string; name: string };
  traitTenant: { id: string; name: string };
  traitDomain: { id: string; name: string };
  traitProduct: { id: string; name: string };
  traitOtherProduct: { id: string; name: string };
  messageId: string;
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
    const level = (s: Own) => ({ tenantId: TENANT, domainId: s.domain.id, productId: s.product.id });
    const channel = (s: Own, name: string) =>
      prisma.channel.create({ data: { name, address: `${name}.v1`, protocol: "kafka", format: "avro", ...level(s) }, select: { id: true, name: true } });
    const trait = (name: string, where: { domainId: string | null; productId: string | null }) =>
      prisma.trait.create({ data: { name, kind: "MESSAGE", tenantId: TENANT, ...where }, select: { id: true, name: true } });

    const traitTenant = await trait(`te-${own.s}`, { domainId: null, productId: null });
    tenantTraits.push(traitTenant.id);
    const entity = await own.entity("Payload");
    const message = await prisma.message.create({ data: { name: `Msg-${own.s}`, payloadEntityId: entity.id, ...level(own) } });
    await run({
      own, other, foreign, messageId: message.id,
      channelOwn: await channel(own, `orders-${own.s}`),
      channelOther: await channel(other, `refunds-${other.s}`),
      traitTenant,
      traitDomain: await trait(`td-${own.s}`, { domainId: own.domain.id, productId: null }),
      traitProduct: await trait(`tp-${own.s}`, { domainId: own.domain.id, productId: own.product.id }),
      traitOtherProduct: await trait(`tq-${other.s}`, { domainId: other.domain.id, productId: other.product.id }),
    });
  } finally {
    await cleanupTenantTraits(prisma, tenantTraits);
    await cleanupDomains(prisma, domainIds);
    await foreign?.cleanup();
  }
}

const route = (s: Own) => ({ domainSlug: s.domain.slug, productSlug: s.product.slug });

describe("loadChannelPage (tenant + product scoped by-id read)", () => {
  it("loads a channel of the addressed product with its links, crumbs and tenant-wide message options", async () => {
    await withFixture(async (f) => {
      const data = await loadChannelPage({ ...route(f.own), channelId: f.channelOwn.id });
      expect(data).not.toBeNull();
      expect(data!.channel).toMatchObject({ id: f.channelOwn.id, name: f.channelOwn.name, productId: f.own.product.id, tenantId: TENANT });
      expect(data!.productId).toBe(f.own.product.id);
      expect(data!.listHref).toBe(`/schemas/${f.own.domain.slug}/${f.own.product.slug}?tab=events&section=channels`);
      expect(data!.crumbs.map((c) => c.label)).toEqual(["Domains", f.own.domain.name, f.own.product.name, "Channels", f.channelOwn.name]);
      expect(data!.crumbs[3].href).toBe(data!.listHref);
      expect(data!.messageOptions.map((m) => m.id)).toContain(f.messageId);
      expect(data!.messageOptions.map((m) => m.id)).not.toContain(f.foreign.message.id);
    });
  });

  it("404s (null) for another product's channel in the same tenant and for another tenant's channel — same as an unknown id", async () => {
    await withFixture(async (f) => {
      expect(await loadChannelPage({ ...route(f.own), channelId: f.channelOther.id })).toBeNull();
      expect(await loadChannelPage({ ...route(f.own), channelId: f.foreign.channel.id })).toBeNull();
      expect(await loadChannelPage({ ...route(f.own), channelId: "c-does-not-exist" })).toBeNull();
      expect(await loadChannelPage({ ...route(f.other), channelId: f.channelOwn.id })).toBeNull();
    });
  });

  it("404s when the product slugs belong to another tenant (and the foreign channel loads only under its own tenant)", async () => {
    await withFixture(async (f) => {
      const foreignRoute = { domainSlug: f.foreign.domain.slug, productSlug: f.foreign.product.slug };
      expect(await loadChannelPage({ ...foreignRoute, channelId: f.foreign.channel.id })).toBeNull();
      expect(await loadChannelPage({ domainSlug: f.own.domain.slug, productSlug: "no-such-product", channelId: f.channelOwn.id })).toBeNull();
      h.getActiveTenantId.mockResolvedValue(f.foreign.tenant.id);
      expect(await loadChannelPage({ ...route(f.own), channelId: f.channelOwn.id })).toBeNull();
      const data = await loadChannelPage({ ...foreignRoute, channelId: f.foreign.channel.id });
      expect(data?.channel.id).toBe(f.foreign.channel.id);
    });
  });
});

describe("loadTraitPage (tenant + level scoped by-id read)", () => {
  it("loads a trait only under its own level's route, with that level's owner target, list link and crumbs", async () => {
    await withFixture(async (f) => {
      const enterprise = await loadTraitPage({ domainSlug: null, productSlug: null, traitId: f.traitTenant.id });
      expect(enterprise?.owner).toEqual({ level: "TENANT", tenantId: TENANT });
      expect(enterprise?.listHref).toBe("/schemas/enterprise?tab=traits");
      expect(enterprise?.crumbs.map((c) => c.label)).toEqual(["Enterprise", "Traits", f.traitTenant.name]);

      const domain = await loadTraitPage({ domainSlug: f.own.domain.slug, productSlug: null, traitId: f.traitDomain.id });
      expect(domain?.owner).toEqual({ level: "DOMAIN", domainId: f.own.domain.id });
      expect(domain?.listHref).toBe(`/schemas/${f.own.domain.slug}?tab=traits`);
      expect(domain?.crumbs.map((c) => c.label)).toEqual(["Domains", f.own.domain.name, "Traits", f.traitDomain.name]);

      const product = await loadTraitPage({ ...route(f.own), traitId: f.traitProduct.id });
      expect(product?.owner).toEqual({ level: "PRODUCT", productId: f.own.product.id });
      expect(product?.listHref).toBe(`/schemas/${f.own.domain.slug}/${f.own.product.slug}?tab=traits`);
      expect(product?.crumbs.map((c) => c.label)).toEqual(["Domains", f.own.domain.name, f.own.product.name, "Traits", f.traitProduct.name]);
      expect(product?.trait).toMatchObject({ id: f.traitProduct.id, kind: "MESSAGE", headers: null });
      expect(Array.isArray(product?.entityOptions)).toBe(true);
    });
  });

  it("404s (null) when the trait is addressed through any other level or product", async () => {
    await withFixture(async (f) => {
      const domainRoute = { domainSlug: f.own.domain.slug, productSlug: null };
      const enterpriseRoute = { domainSlug: null, productSlug: null };
      expect(await loadTraitPage({ ...enterpriseRoute, traitId: f.traitDomain.id })).toBeNull();
      expect(await loadTraitPage({ ...enterpriseRoute, traitId: f.traitProduct.id })).toBeNull();
      expect(await loadTraitPage({ ...domainRoute, traitId: f.traitTenant.id })).toBeNull();
      expect(await loadTraitPage({ ...domainRoute, traitId: f.traitProduct.id })).toBeNull();
      expect(await loadTraitPage({ ...route(f.own), traitId: f.traitDomain.id })).toBeNull();
      expect(await loadTraitPage({ ...route(f.own), traitId: f.traitTenant.id })).toBeNull();
      expect(await loadTraitPage({ ...route(f.own), traitId: f.traitOtherProduct.id })).toBeNull();
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
