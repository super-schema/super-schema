import { beforeEach, describe, expect, it, vi } from "vitest";
import { globalAdmin, signInAs } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  loadEntityWorkspace: vi.fn(),
  getActiveTenantId: vi.fn(),
  domainFindFirst: vi.fn(),
  productFindFirst: vi.fn(),
  entityFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    domain: { findFirst: mocks.domainFindFirst },
    product: { findFirst: mocks.productFindFirst },
    entity: { findFirst: mocks.entityFindFirst },
  },
}));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.getActiveTenantId, requireActiveTenantId: mocks.getActiveTenantId, NO_ACCESS_PATH: "/no-access" }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/load-entity-workspace", () => ({
  loadEntityWorkspace: mocks.loadEntityWorkspace,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace", () => ({
  EntityWorkspace: () => null,
}));

import ProductEntityPage from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/page";
import EnterpriseEntityPage from "@/app/(dashboard)/schemas/enterprise/entities/[entityId]/page";

const PROPS = { level: "PRODUCT", entity: { id: "ent-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  signInAs(globalAdmin());
  mocks.getActiveTenantId.mockResolvedValue("tenant-1");
});

describe("EnterpriseEntityPage", () => {
  it("loads a tenant-level entity (productId null) in the active tenant and renders it", async () => {
    mocks.loadEntityWorkspace.mockResolvedValue({ props: { ...PROPS, level: "TENANT" } });

    const element = await EnterpriseEntityPage({ params: Promise.resolve({ entityId: "customer" }) });

    expect(mocks.loadEntityWorkspace).toHaveBeenCalledWith({
      slugOrId: "customer",
      productId: null,
      tenantId: "tenant-1",
    });
    expect(element.props).toMatchObject({ level: "TENANT" });
  });

  it("404s when the entity does not exist at the Enterprise level", async () => {
    mocks.loadEntityWorkspace.mockResolvedValue(null);

    await expect(
      EnterpriseEntityPage({ params: Promise.resolve({ entityId: "missing" }) })
    ).rejects.toThrow("not found");
  });
});

describe("ProductEntityPage", () => {
  const params = Promise.resolve({ domainSlug: "payments", productSlug: "checkout", entityId: "order" });

  beforeEach(() => {
    mocks.domainFindFirst.mockResolvedValue({ id: "dom-1", tenantId: "tenant-1" });
    mocks.productFindFirst.mockResolvedValue({ id: "prod-1" });
  });

  it("loads the entity within the URL's product and the domain's tenant", async () => {
    mocks.loadEntityWorkspace.mockResolvedValue({ props: PROPS });

    const element = await ProductEntityPage({ params });

    expect(mocks.domainFindFirst).toHaveBeenCalledWith({ where: { slug: "payments", tenantId: "tenant-1" } });
    expect(mocks.productFindFirst).toHaveBeenCalledWith({
      where: { slug: "checkout", domainId: "dom-1" },
      select: { id: true },
    });
    expect(mocks.loadEntityWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.loadEntityWorkspace).toHaveBeenCalledWith({
      slugOrId: "order",
      productId: "prod-1",
      tenantId: "tenant-1",
    });
    expect(element.props).toMatchObject({ level: "PRODUCT" });
  });

  it("resolves a legacy link under a stale product segment to the entity's real placement", async () => {
    mocks.productFindFirst.mockResolvedValue(null);
    mocks.entityFindFirst.mockResolvedValue({ productId: "prod-9", tenantId: "tenant-1" });
    mocks.loadEntityWorkspace.mockResolvedValue({ props: PROPS });

    await ProductEntityPage({ params });

    expect(mocks.entityFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", OR: [{ id: "order" }, { slug: "order", domainId: "dom-1" }] },
      select: { productId: true, tenantId: true },
    });
    expect(mocks.loadEntityWorkspace).toHaveBeenCalledWith({
      slugOrId: "order",
      productId: "prod-9",
      tenantId: "tenant-1",
    });
  });

  it("404s when neither the URL placement nor the legacy fallback finds the entity", async () => {
    mocks.loadEntityWorkspace.mockResolvedValue(null);
    mocks.entityFindFirst.mockResolvedValue(null);

    await expect(ProductEntityPage({ params })).rejects.toThrow("not found");
  });

  it("falls back to the id lookup, INSIDE the tenant in view, when the domain itself is unknown", async () => {
    mocks.domainFindFirst.mockResolvedValue(null);
    mocks.entityFindFirst.mockResolvedValue(null);

    await expect(ProductEntityPage({ params })).rejects.toThrow("not found");
    expect(mocks.productFindFirst).not.toHaveBeenCalled();
    expect(mocks.entityFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", OR: [{ id: "order" }] },
      select: { productId: true, tenantId: true },
    });
  });

  it("never looks a domain up outside the tenant in view: a slug that only another tenant has is a 404, with no tenant-agnostic fallback", async () => {
    mocks.domainFindFirst.mockImplementation(async ({ where }: { where: { slug: string; tenantId?: string } }) =>
      where.tenantId === "tenant-1" ? null : { id: "dom-of-another-tenant", tenantId: "tenant-2" }
    );
    mocks.entityFindFirst.mockResolvedValue(null);

    await expect(ProductEntityPage({ params })).rejects.toThrow("not found");
    for (const [arg] of mocks.domainFindFirst.mock.calls) expect(arg.where.tenantId).toBe("tenant-1");
    expect(mocks.loadEntityWorkspace).not.toHaveBeenCalled();
  });

  it("a user with no role at all is sent to /no-access before anything is read", async () => {
    signInAs(null);
    await expect(ProductEntityPage({ params })).rejects.toThrow("NEXT_REDIRECT /no-access");
    expect(mocks.domainFindFirst).not.toHaveBeenCalled();
  });
});
