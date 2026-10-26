// @vitest-environment node
/**
 * The pages that read the database directly decide at the DATA layer, from the principal's assignments (the layout is not the boundary): the Domains page,
 * a domain's page and the lineage graph. A role-less user is sent to /no-access, a domain or an entity the caller's roles do not cover is a 404 or is absent,
 * and what is counted or listed is restricted in the query, never filtered after the whole tenant was loaded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, signInAs } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  activeTenant: vi.fn(),
  domainFindMany: vi.fn(),
  domainFindFirst: vi.fn(),
  entityGroupBy: vi.fn(),
  entityFindMany: vi.fn(),
  tierFindMany: vi.fn(),
  rows: vi.fn(),
  loadLevelTraits: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ requireActiveTenantId: mocks.activeTenant, getActiveTenantId: mocks.activeTenant, NO_ACCESS_PATH: "/no-access" }));
vi.mock("@/lib/db", () => ({
  prisma: {
    domain: { findMany: mocks.domainFindMany, findFirst: mocks.domainFindFirst },
    entity: { groupBy: mocks.entityGroupBy, findMany: mocks.entityFindMany },
    productTier: { findMany: mocks.tierFindMany },
    sharedEnum: { findMany: mocks.rows },
    customScalar: { findMany: mocks.rows },
    unionType: { findMany: mocks.rows },
    serviceDefinition: { findMany: mocks.rows },
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/features/events/workspace/load-events-tab-data", () => ({ loadLevelTraits: mocks.loadLevelTraits }));
vi.mock("@/app/(dashboard)/schemas/domain-grid", () => ({ DomainGrid: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/domain-tabs", () => ({ DomainTabs: () => null }));
vi.mock("@/app/(dashboard)/lineage/lineage-client", () => ({ LineagePageClient: () => null }));

import SchemasPage from "@/app/(dashboard)/schemas/page";
import DomainProductsPage from "@/app/(dashboard)/schemas/[domainSlug]/page";
import LineagePage from "@/app/(dashboard)/lineage/page";

const NOW = new Date("2026-10-01T00:00:00Z");
const domainRow = (id: string, slug: string, extra: Record<string, unknown> = {}) => ({
  id, tenantId: "t1", name: slug, slug, description: "", isSystem: false, createdAt: NOW, ...extra,
});
const withImpact = (row: ReturnType<typeof domainRow>) => ({
  ...row,
  _count: { entities: 5, modelDefinitions: 0, decoratorDefinitions: 0, sharedEnums: 1, customScalars: 0, unionTypes: 0, services: 0, interfaces: 0, userRoles: 2, traits: 0, eventSpecs: 0 },
  products: [{ _count: { sharedEnums: 0, customScalars: 0, unionTypes: 0, services: 0 } }],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeTenant.mockResolvedValue("t1");
  signInAs(globalAdmin());
  mocks.rows.mockResolvedValue([]);
  mocks.tierFindMany.mockResolvedValue([]);
  mocks.loadLevelTraits.mockResolvedValue({ own: [], inherited: [] });
});

describe("the Domains page", () => {
  beforeEach(() => {
    mocks.domainFindMany.mockImplementation(async (args: { include?: unknown }) => [domainRow("d1", "billing"), domainRow("d2", "shipping")].map((d) => (args.include ? withImpact(d) : d)));
    mocks.entityGroupBy.mockResolvedValue([{ domainId: "d1", _count: { _all: 3 } }]);
  });

  it("a tenant administrator sees every domain, may delete, and is given the impact figures of the delete dialog", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", "t1")]));
    const element = await SchemasPage();
    expect(element.props.canDeleteDomains).toBe(true);
    expect(element.props.domains.map((d: { slug: string }) => d.slug)).toEqual(["billing", "shipping"]);
    expect(element.props.domains[0].deletionImpact).toMatchObject({ entities: 5, userRoles: 2, sharedEnums: 1, products: 1 });
    expect(mocks.domainFindMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });

  it("a global-admin-only rule is gone: a TENANT administrator may delete, a platform one too, an author of the tenant may not", async () => {
    signInAs(principalOf([assign.tenant("AUTHOR", "t1")]));
    expect((await SchemasPage()).props.canDeleteDomains).toBe(false);
    signInAs(principalOf([assign.global()]));
    expect((await SchemasPage()).props.canDeleteDomains).toBe(true);
  });

  it("a caller who may not delete is not shown what deleting would take: the heavy count query is not asked, the impact is zeros", async () => {
    signInAs(principalOf([assign.tenant("VIEWER", "t1")]));
    const element = await SchemasPage();
    expect(mocks.domainFindMany.mock.calls[0][0]).not.toHaveProperty("include");
    expect(element.props.domains[0].deletionImpact).toMatchObject({ entities: 0, userRoles: 0, sharedEnums: 0 });
    // ... and the entity count on the card is what they may read, grouped in the query
    expect(element.props.domains[0].entityCount).toBe(3);
    expect(element.props.domains[1].entityCount).toBe(0);
    expect(mocks.entityGroupBy.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });

  it("a domain role lists its own domain only, and counts only the entities under it", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", "t1", "d1")]));
    const element = await SchemasPage();
    expect(element.props.domains.map((d: { slug: string }) => d.slug)).toEqual(["billing"]);
    expect(mocks.entityGroupBy.mock.calls[0][0].where).toEqual({ tenantId: "t1", OR: [{ domainId: { in: ["d1"] } }, { productId: { in: [] } }] });
  });

  it("a user with no role at all is sent to /no-access and nothing is read; so is nobody at all", async () => {
    signInAs(principalOf([]));
    mocks.activeTenant.mockImplementation(async () => {
      throw new Error("NEXT_REDIRECT /no-access");
    });
    await expect(SchemasPage()).rejects.toThrow("NEXT_REDIRECT /no-access");
    signInAs(null);
    await expect(SchemasPage()).rejects.toThrow("NEXT_REDIRECT /no-access");
    expect(mocks.domainFindMany).not.toHaveBeenCalled();
  });
});

describe("a domain's page", () => {
  const params = Promise.resolve({ domainSlug: "billing" });
  const DOMAIN = { ...domainRow("d1", "billing"), tenantId: "t1", products: [
    { id: "p1", domainId: "d1", name: "Invoices", slug: "invoices", description: "", ownerTeam: null, isSystem: false, updatedAt: NOW, tier: null, _count: { entities: 0, sharedEnums: 0, customScalars: 0, unionTypes: 0, services: 0, traits: 0, eventSpecs: 0 } },
    { id: "p2", domainId: "d1", name: "Payments", slug: "payments", description: "", ownerTeam: null, isSystem: false, updatedAt: NOW, tier: null, _count: { entities: 0, sharedEnums: 0, customScalars: 0, unionTypes: 0, services: 0, traits: 0, eventSpecs: 0 } },
  ] };

  beforeEach(() => {
    mocks.domainFindFirst.mockResolvedValue(DOMAIN);
  });

  it("looks the domain up inside the tenant in view and nowhere else (a slug that only another tenant has is a 404)", async () => {
    await DomainProductsPage({ params });
    expect(mocks.domainFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.domainFindFirst.mock.calls[0][0].where).toEqual({ slug: "billing", tenantId: "t1" });
    mocks.domainFindFirst.mockResolvedValue(null);
    await expect(DomainProductsPage({ params })).rejects.toThrow("not found");
    expect(mocks.domainFindFirst).toHaveBeenCalledTimes(2);
  });

  it("a role over the whole domain sees all its products and the domain's own assets and traits, and the Enterprise ones only with a tenant role", async () => {
    signInAs(principalOf([assign.domain("VIEWER", "t1", "d1")]));
    const element = await DomainProductsPage({ params });
    expect(element.props.productGridProps.products.map((p: { slug: string }) => p.slug)).toEqual(["invoices", "payments"]);
    // the domain's own four queries ran, the Enterprise three did not
    expect(mocks.rows).toHaveBeenCalledTimes(4);
    expect(mocks.loadLevelTraits.mock.calls[0][0].read).toEqual({ own: true, enterprise: false });

    mocks.rows.mockClear();
    signInAs(principalOf([assign.tenant("VIEWER", "t1")]));
    await DomainProductsPage({ params });
    expect(mocks.rows).toHaveBeenCalledTimes(7);
    expect(mocks.loadLevelTraits.mock.calls[1][0].read).toEqual({ own: true, enterprise: true });
  });

  it("a role at one product opens the domain as a parent and lists that product only; the domain's own assets and traits are not read", async () => {
    signInAs(principalOf([assign.product("VIEWER", "t1", "d1", "p2")]));
    const element = await DomainProductsPage({ params });
    expect(element.props.productGridProps.products.map((p: { slug: string }) => p.slug)).toEqual(["payments"]);
    expect(mocks.rows).not.toHaveBeenCalled();
    expect(mocks.loadLevelTraits.mock.calls[0][0].read).toEqual({ own: false, enterprise: false });
  });

  it("a role at another domain, a role in another tenant and a user with no role get a 404, and nothing under the domain is read", async () => {
    for (const assignments of [[assign.domain("ADMIN", "t1", "d2")], [assign.tenant("ADMIN", "t2")], []]) {
      signInAs(principalOf(assignments));
      mocks.rows.mockClear();
      await expect(DomainProductsPage({ params }), JSON.stringify(assignments)).rejects.toThrow("not found");
      expect(mocks.rows).not.toHaveBeenCalled();
    }
    expect(mocks.loadLevelTraits).not.toHaveBeenCalled();
  });
});

describe("the lineage graph", () => {
  const entity = (id: string, over: Record<string, unknown> = {}) => ({
    id, name: id, slug: id, description: "", status: "DRAFT", metadata: {}, domain: null, product: null, fields: [], _count: { fields: 0 }, ...over,
  });

  it("lists the entities of the tenant in view that the caller may read, restricted in the query, and draws no edge to an entity that is not on their graph", async () => {
    signInAs(principalOf([assign.domain("VIEWER", "t1", "d1")]));
    mocks.entityFindMany.mockResolvedValue([
      entity("e1", { metadata: { relationships: [{ targetEntityId: "e2", cardinality: "one-to-many" }, { targetEntityId: "e-hidden", cardinality: "one-to-many" }] } }),
      entity("e2"),
    ]);
    const element = await LineagePage();
    expect(mocks.entityFindMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", OR: [{ domainId: { in: ["d1"] } }, { productId: { in: [] } }] });
    const graph = element.props.children[1].props.children.props.entities as Array<{ id: string; relationships: Array<{ targetEntityId: string }> }>;
    expect(graph.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(graph[0].relationships.map((r) => r.targetEntityId)).toEqual(["e2"]);
  });

  it("a tenant-wide role adds no restriction; a user with no role is sent to /no-access and nothing is read", async () => {
    signInAs(principalOf([assign.tenant("VIEWER", "t1")]));
    mocks.entityFindMany.mockResolvedValue([]);
    await LineagePage();
    expect(mocks.entityFindMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    mocks.entityFindMany.mockClear();
    signInAs(null);
    await expect(LineagePage()).rejects.toThrow("NEXT_REDIRECT /no-access");
    expect(mocks.entityFindMany).not.toHaveBeenCalled();
  });
});
