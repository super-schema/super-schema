// @vitest-environment node
/**
 * The loaders of the events and traits pages decide at the data layer (access-control Task 6): the route scope (`resolveProductRoute`, `resolveLevelRoute`)
 * answers null (a 404) for what the caller's roles do not cover and never throws for a user with no role, the option loaders restrict their queries to what the
 * caller may read, and the shared picker loader takes the same restriction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, signInAs, signedOut } from "../../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  activeTenant: vi.fn(),
  productFindFirst: vi.fn(),
  domainFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
  entityFindMany: vi.fn(),
  traitFindMany: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.activeTenant }));
vi.mock("@/lib/db", () => ({
  prisma: {
    product: { findFirst: mocks.productFindFirst },
    domain: { findFirst: mocks.domainFindFirst },
    tenant: { findUnique: mocks.tenantFindUnique },
    entity: { findMany: mocks.entityFindMany },
    trait: { findMany: mocks.traitFindMany },
  },
}));

import { NoTenantAccess } from "@/lib/access/no-tenant-access";
import { resolveLevelRoute, resolveProductRoute } from "@/features/events/route-scope";
import { loadEntityOptions, loadTraitOptions } from "@/features/events/load-options";
import { loadPickableEntities } from "@/lib/references/pickable-entities";

const PRODUCT = { id: "p1", name: "Invoices", slug: "invoices", domain: { id: "d1", name: "Billing", slug: "billing", tenant: { id: "t1", slug: "t-one" } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeTenant.mockResolvedValue("t1");
  mocks.productFindFirst.mockResolvedValue(PRODUCT);
  mocks.domainFindFirst.mockResolvedValue({ id: "d1", name: "Billing", slug: "billing" });
  mocks.tenantFindUnique.mockResolvedValue({ id: "t1", slug: "t-one" });
  mocks.entityFindMany.mockResolvedValue([]);
  mocks.traitFindMany.mockResolvedValue([]);
  signInAs(principalOf([assign.tenant("VIEWER", "t1")]));
});

describe("resolveProductRoute", () => {
  it.each([
    ["a viewer of the tenant", [assign.tenant("VIEWER", "t1")]],
    ["a role over the domain", [assign.domain("VIEWER", "t1", "d1")]],
    ["a role over exactly this product", [assign.product("VIEWER", "t1", "d1", "p1")]],
    ["a platform administrator", [assign.global()]],
  ])("%s resolves it", async (_who, assignments) => {
    signInAs(principalOf(assignments));
    expect(await resolveProductRoute("billing", "invoices")).toMatchObject({ tenantId: "t1", domain: { id: "d1" }, product: { id: "p1" } });
  });

  it.each([
    ["a role over ANOTHER product of the domain", [assign.product("ADMIN", "t1", "d1", "p2")]],
    ["a role over another domain", [assign.domain("ADMIN", "t1", "d2")]],
    ["a role in another tenant", [assign.tenant("ADMIN", "t2")]],
    ["no role at all", []],
  ])("%s gets null (a 404)", async (_who, assignments) => {
    signInAs(principalOf(assignments));
    expect(await resolveProductRoute("billing", "invoices")).toBeNull();
  });

  it("looks the product up inside the tenant in view", async () => {
    await resolveProductRoute("billing", "invoices");
    expect(mocks.productFindFirst.mock.calls[0][0].where).toEqual({ slug: "invoices", domain: { slug: "billing", tenantId: "t1" } });
  });

  it("is null for nobody and for a user who may reach no tenant (never a throw), and does not hide any other failure", async () => {
    signedOut();
    expect(await resolveProductRoute("billing", "invoices")).toBeNull();
    signInAs(principalOf([]));
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    expect(await resolveProductRoute("billing", "invoices")).toBeNull();
    expect(mocks.productFindFirst).not.toHaveBeenCalled();
    mocks.activeTenant.mockRejectedValue(new Error("connection lost"));
    await expect(resolveProductRoute("billing", "invoices")).rejects.toThrow("connection lost");
  });
});

describe("resolveLevelRoute", () => {
  it("the Enterprise level is the tenant itself: a tenant role resolves it, a domain or product role does not", async () => {
    expect(await resolveLevelRoute(null, null)).toMatchObject({ scope: { tenantId: "t1", domainId: null, productId: null } });
    signInAs(principalOf([assign.domain("ADMIN", "t1", "d1")]));
    expect(await resolveLevelRoute(null, null)).toBeNull();
    signInAs(principalOf([assign.product("ADMIN", "t1", "d1", "p1")]));
    expect(await resolveLevelRoute(null, null)).toBeNull();
  });

  it("a domain level needs a role that covers the domain or one of its products (a parent)", async () => {
    signInAs(principalOf([assign.domain("VIEWER", "t1", "d1")]));
    expect(await resolveLevelRoute("billing", null)).toMatchObject({ scope: { domainId: "d1" } });
    signInAs(principalOf([assign.domain("VIEWER", "t1", "d2")]));
    expect(await resolveLevelRoute("billing", null)).toBeNull();
    signInAs(principalOf([]));
    expect(await resolveLevelRoute("billing", null)).toBeNull();
  });

  it("a product level is resolved through the product route (its own checks)", async () => {
    signInAs(principalOf([assign.product("VIEWER", "t1", "d1", "p1")]));
    expect(await resolveLevelRoute("billing", "invoices")).toMatchObject({ scope: { productId: "p1" } });
    signInAs(principalOf([assign.product("VIEWER", "t1", "d1", "p2")]));
    expect(await resolveLevelRoute("billing", "invoices")).toBeNull();
  });

  it("is null for nobody and for a user who may reach no tenant", async () => {
    signedOut();
    expect(await resolveLevelRoute(null, null)).toBeNull();
    signInAs(principalOf([]));
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    expect(await resolveLevelRoute("billing", null)).toBeNull();
  });
});

describe("the option loaders take the caller's restriction", () => {
  it("loadEntityOptions: every entity of the tenant by default, only the readable ones with a restriction (the tenant cannot be overridden by it)", async () => {
    await loadEntityOptions("t1");
    expect(mocks.entityFindMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    await loadEntityOptions("t1", { OR: [{ domainId: { in: ["d1"] } }, { productId: { in: [] } }] });
    expect(mocks.entityFindMany.mock.calls[1][0].where).toEqual({ tenantId: "t1", OR: [{ domainId: { in: ["d1"] } }, { productId: { in: [] } }] });
    await loadEntityOptions("t1", { tenantId: "another-tenant" });
    expect(mocks.entityFindMany.mock.calls[2][0].where.tenantId).toBe("t1");
  });

  it("loadPickableEntities: the same", async () => {
    await loadPickableEntities({ entity: { findMany: mocks.entityFindMany } } as never, "t1", { OR: [{ domainId: { in: ["d1"] } }] });
    expect(mocks.entityFindMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", OR: [{ domainId: { in: ["d1"] } }] });
    await loadPickableEntities({ entity: { findMany: mocks.entityFindMany } } as never, "t1", { tenantId: "another-tenant" });
    expect(mocks.entityFindMany.mock.calls[1][0].where.tenantId).toBe("t1");
  });

  it("loadTraitOptions: the Enterprise and the domain lists are asked for only where the caller may read them, and neither asks nothing", async () => {
    const scope = { tenantId: "t1", domainId: "d1", productId: null };
    await loadTraitOptions(scope, "MESSAGE");
    expect(mocks.traitFindMany.mock.calls[0][0].where.OR).toEqual([{ domainId: null }, { domainId: "d1", productId: null }]);
    await loadTraitOptions(scope, "MESSAGE", { enterprise: false, domain: true });
    expect(mocks.traitFindMany.mock.calls[1][0].where.OR).toEqual([{ domainId: "d1", productId: null }]);
    await loadTraitOptions(scope, "MESSAGE", { enterprise: true, domain: false });
    expect(mocks.traitFindMany.mock.calls[2][0].where.OR).toEqual([{ domainId: null }]);
    mocks.traitFindMany.mockClear();
    expect(await loadTraitOptions(scope, "MESSAGE", { enterprise: false, domain: false })).toEqual([]);
    expect(mocks.traitFindMany).not.toHaveBeenCalled();
  });
});
