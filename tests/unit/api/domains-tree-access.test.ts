// @vitest-environment node
/**
 * GET /api/domains-tree is the explorer tree of the tenant in view, AS FAR AS THE CALLER'S ROLES REACH: the structure (the domains and products a
 * role covers, a role at a product showing its domain as a parent only) and every count under it, each restricted by what the caller may read of
 * that kind, in the query. A user with no role in the tenant is told 404, never a 500 and never an empty tree that says the tenant exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  activeTenant: vi.fn(),
  prisma: {
    domain: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
    entity: { findMany: vi.fn() },
    sharedEnum: { findMany: vi.fn() },
    customScalar: { findMany: vi.fn() },
    unionType: { findMany: vi.fn() },
    serviceDefinition: { findMany: vi.fn() },
    trait: { groupBy: vi.fn() },
    eventSpec: { groupBy: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/active-tenant")>()), getActiveTenantId: mocks.activeTenant }));

import { NoTenantAccess } from "@/lib/access/no-tenant-access";
import { GET as rawGet } from "@/app/api/domains-tree/route";
import type { ExplorerTree } from "@/lib/navigation/build-explorer-tree";

const ROUTE = { params: Promise.resolve({}) };
const GET = () => rawGet(new Request("http://localhost/api/domains-tree"), ROUTE);
const queries = () => Object.values(mocks.prisma).reduce((n, model) => n + Object.values(model).reduce((m, fn) => m + (fn as ReturnType<typeof vi.fn>).mock.calls.length, 0), 0);
const whereOf = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[0][0].where;

const DOMAINS = [
  { id: "d1", name: "Billing", slug: "billing", isSystem: false },
  { id: "d2", name: "Shipping", slug: "shipping", isSystem: false },
];
const PRODUCTS = [
  { id: "p1", domainId: "d1", name: "Invoices", slug: "invoices", isSystem: false },
  { id: "p2", domainId: "d1", name: "Payments", slug: "payments", isSystem: false },
  { id: "p3", domainId: "d2", name: "Parcels", slug: "parcels", isSystem: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeTenant.mockResolvedValue("t1");
  mocks.prisma.domain.findMany.mockResolvedValue(DOMAINS);
  mocks.prisma.product.findMany.mockResolvedValue(PRODUCTS);
  for (const model of ["entity", "sharedEnum", "customScalar", "unionType", "serviceDefinition"] as const) mocks.prisma[model].findMany.mockResolvedValue([]);
  mocks.prisma.trait.groupBy.mockResolvedValue([]);
  mocks.prisma.eventSpec.groupBy.mockResolvedValue([]);
});

const treeOf = async () => (await (await GET()).json()) as ExplorerTree;

describe("GET /api/domains-tree: who may see how much of the tree", () => {
  it("a viewer of the tenant sees every domain and product, and every query asks for the tenant's rows only (no scope restriction)", async () => {
    signInAs(tenantMember("VIEWER", "t1"));
    const tree = await treeOf();
    expect(tree.domains.map((d) => d.slug)).toEqual(["billing", "shipping"]);
    expect(tree.domains[0].products.map((p) => p.slug)).toEqual(["invoices", "payments"]);
    expect(whereOf(mocks.prisma.domain.findMany)).toEqual({ tenantId: "t1" });
    expect(whereOf(mocks.prisma.entity.findMany)).toEqual({ tenantId: "t1" });
    expect(whereOf(mocks.prisma.sharedEnum.findMany)).toEqual({ tenantId: "t1" });
    expect(whereOf(mocks.prisma.trait.groupBy)).toEqual({ tenantId: "t1" });
    expect(whereOf(mocks.prisma.eventSpec.groupBy)).toEqual({ tenantId: "t1" });
  });

  it("a platform administrator sees the tree of the tenant in view, and no other tenant's rows", async () => {
    signInAs(globalAdmin());
    expect((await treeOf()).domains).toHaveLength(2);
    for (const model of ["domain", "entity", "sharedEnum"] as const) expect(whereOf(mocks.prisma[model].findMany).tenantId).toBe("t1");
  });

  it("a domain-scoped role sees its own domain with its products, not the sibling domain, and the counts are restricted to what it reads", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", "t1", "d1")]));
    const tree = await treeOf();
    expect(tree.domains.map((d) => d.slug)).toEqual(["billing"]);
    expect(tree.domains[0].products.map((p) => p.slug)).toEqual(["invoices", "payments"]);
    const restricted = { tenantId: "t1", OR: [{ domainId: { in: ["d1"] } }, { productId: { in: [] } }] };
    expect(whereOf(mocks.prisma.entity.findMany)).toEqual(restricted);
    for (const model of ["sharedEnum", "customScalar", "unionType", "serviceDefinition"] as const) expect(whereOf(mocks.prisma[model].findMany), model).toEqual(restricted);
    expect(whereOf(mocks.prisma.trait.groupBy)).toEqual(restricted);
    expect(whereOf(mocks.prisma.eventSpec.groupBy)).toEqual(restricted);
  });

  it("a product-scoped role sees its domain as a PARENT and that product only: never the sibling product, never the domain's other assets", async () => {
    signInAs(principalOf([assign.product("VIEWER", "t1", "d1", "p2")]));
    const tree = await treeOf();
    expect(tree.domains.map((d) => d.slug)).toEqual(["billing"]);
    expect(tree.domains[0].products.map((p) => p.slug)).toEqual(["payments"]);
    // what is counted is only what the product role reaches: no domain-level row (the OR names no domain), the product's own rows
    expect(whereOf(mocks.prisma.entity.findMany)).toEqual({ tenantId: "t1", OR: [{ domainId: { in: [] } }, { productId: { in: ["p2"] } }] });
    expect(whereOf(mocks.prisma.sharedEnum.findMany).OR).toEqual([{ domainId: { in: [] } }, { productId: { in: ["p2"] } }]);
  });

  it("roles of different depths add up in the restriction (a domain and a product elsewhere), for every kind of row alike", async () => {
    signInAs(principalOf([assign.domain("VIEWER", "t1", "d1"), assign.product("VIEWER", "t1", "d2", "p3")]));
    await treeOf();
    const both = { tenantId: "t1", OR: [{ domainId: { in: ["d1"] } }, { productId: { in: ["p3"] } }] };
    expect(whereOf(mocks.prisma.entity.findMany)).toEqual(both);
    expect(whereOf(mocks.prisma.trait.groupBy)).toEqual(both);
    expect(whereOf(mocks.prisma.eventSpec.groupBy)).toEqual(both);
  });

  it("a role in ANOTHER tenant than the one in view sees nothing: 404, no query", async () => {
    signInAs(tenantMember("ADMIN", "t9"));
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(queries()).toBe(0);
  });

  it("a user with no role at all is a 404 and no query, with or without a tenant to reach (never a 500)", async () => {
    signInAs(roleless());
    expect((await GET()).status).toBe(404);
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    expect((await GET()).status).toBe(404);
    expect(queries()).toBe(0);
  });

  it("nobody is a 401 and no query", async () => {
    signedOut();
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
    expect(queries()).toBe(0);
  });
});
