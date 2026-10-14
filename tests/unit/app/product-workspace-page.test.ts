import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveTenantId: vi.fn(),
  domainFindFirst: vi.fn(),
  entityFindFirst: vi.fn(),
  entityFindMany: vi.fn(),
  fieldGroupBy: vi.fn(),
  empty: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

// Only the queries the product workspace actually needs exist on the mock:
// calling anything else (modelDefinition, decoratorDefinition, domain._count
// aggregate, per-field row loads) throws and fails the test.
vi.mock("@/lib/db", () => ({
  prisma: {
    domain: { findFirst: mocks.domainFindFirst },
    entity: { findFirst: mocks.entityFindFirst, findMany: mocks.entityFindMany },
    field: { groupBy: mocks.fieldGroupBy },
    sharedEnum: { findMany: mocks.empty },
    customScalar: { findMany: mocks.empty },
    unionType: { findMany: mocks.empty },
    serviceDefinition: { findMany: mocks.empty },
  },
}));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.getActiveTenantId }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
  redirect: mocks.redirect,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/domain-workspace", () => ({
  DomainWorkspace: () => null,
}));

import ProductWorkspacePage from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/page";

const params = Promise.resolve({ domainSlug: "payments", productSlug: "checkout" });
const DOMAIN = {
  id: "dom-1",
  tenantId: "tenant-1",
  name: "Payments",
  slug: "payments",
  description: "",
  isSystem: false,
  products: [{ id: "prod-1", name: "Checkout", slug: "checkout" }],
};

function entityRow(id: string, fields: number) {
  return {
    id,
    name: id.toUpperCase(),
    slug: id,
    description: "",
    status: "DRAFT",
    version: 1,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    _count: { fields },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveTenantId.mockResolvedValue("tenant-1");
  mocks.domainFindFirst.mockResolvedValue(DOMAIN);
  mocks.empty.mockResolvedValue([]);
  mocks.entityFindMany.mockResolvedValue([entityRow("e1", 4), entityRow("e2", 0)]);
  mocks.fieldGroupBy.mockResolvedValue([
    { entityId: "e1", classification: "PII", _count: 2 },
    { entityId: "e1", classification: "PUBLIC", _count: 1 },
    { entityId: "e1", classification: null, _count: 1 },
  ]);
});

describe("ProductWorkspacePage", () => {
  it("resolves domain and product in one query, scoped to the active tenant", async () => {
    await ProductWorkspacePage({ params });

    expect(mocks.domainFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.domainFindFirst).toHaveBeenCalledWith({
      where: { slug: "payments", tenantId: "tenant-1" },
      include: { products: { where: { slug: "checkout" }, take: 1 } },
    });
  });

  it("builds classification counts from one field.groupBy, not from field rows", async () => {
    const element = await ProductWorkspacePage({ params });

    expect(mocks.fieldGroupBy).toHaveBeenCalledTimes(1);
    expect(mocks.fieldGroupBy).toHaveBeenCalledWith({
      by: ["entityId", "classification"],
      where: { entity: { productId: "prod-1" } },
      _count: true,
    });
    const entityArgs = mocks.entityFindMany.mock.calls[0][0];
    expect(entityArgs.where).toEqual({ productId: "prod-1" });
    expect(entityArgs.include).toEqual({ _count: { select: { fields: true } } });

    const [e1, e2] = element.props.entities;
    expect(e1).toMatchObject({ id: "e1", fieldCount: 4 });
    expect(e1.classifications).toEqual({ NEVER_STORED: 0, PII: 2, SENSITIVE: 1, INTERNAL: 0, PUBLIC: 1 });
    expect(e2).toMatchObject({ id: "e2", fieldCount: 0 });
    expect(e2.classifications).toEqual({ NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 });
  });

  it("does not load or pass unused models, decorators or deletion impact", async () => {
    const element = await ProductWorkspacePage({ params });

    expect(element.props.models).toBeUndefined();
    expect(element.props.decoratorDefinitions).toBeUndefined();
    expect(element.props.deletionImpact).toBeUndefined();
    expect(element.props.canDeleteDomain).toBe(false);
    expect(element.props).toMatchObject({
      domainId: "dom-1",
      productId: "prod-1",
      productName: "Checkout",
      domainSlug: "payments",
      productSlug: "checkout",
    });
  });

  it("falls back to an unscoped domain lookup when the slug is outside the active tenant", async () => {
    mocks.domainFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(DOMAIN);
    await ProductWorkspacePage({ params });

    expect(mocks.domainFindFirst).toHaveBeenCalledTimes(2);
    expect(mocks.domainFindFirst.mock.calls[1][0].where).toEqual({ slug: "payments" });
  });

  it("404s when the domain does not exist", async () => {
    mocks.domainFindFirst.mockResolvedValue(null);
    await expect(ProductWorkspacePage({ params })).rejects.toThrow("not found");
  });

  it("redirects a legacy 2-segment entity link to the canonical entity URL, keeping the query", async () => {
    mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, products: [] });
    mocks.entityFindFirst.mockResolvedValue({ slug: "checkout", product: { slug: "web" } });

    await expect(
      ProductWorkspacePage({
        params,
        searchParams: Promise.resolve({ tab: "apis", x: ["1", "2"] }),
      })
    ).rejects.toThrow("redirect:/schemas/payments/web/checkout?tab=apis&x=1&x=2");
    expect(mocks.entityFindMany).not.toHaveBeenCalled();
  });

  it("404s when neither a product nor a legacy entity matches", async () => {
    mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, products: [] });
    mocks.entityFindFirst.mockResolvedValue(null);
    await expect(ProductWorkspacePage({ params })).rejects.toThrow("not found");
  });
});
