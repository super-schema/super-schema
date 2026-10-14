import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  entities: [] as Row[],
  fields: [] as Row[],
  domains: [] as Row[],
  products: [] as Row[],
  activeTenantId: "tenant-1",
}));

/** Minimal in-memory `where` matcher: scalar equality plus `OR`/`AND`. Order = insertion order. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some((w) => matches(row, w));
    if (key === "AND") return (value as Row[]).every((w) => matches(row, w));
    return row[key] === value;
  });
}
function findFirst(rows: () => Row[]) {
  return vi.fn(async (args?: { where?: Row }) => rows().find((r) => matches(r, args?.where)) ?? null);
}

const mocks = vi.hoisted(() => ({
  entityFindFirst: vi.fn(),
  fieldFindFirst: vi.fn(),
  fieldFindUnique: vi.fn(),
  domainFindFirst: vi.fn(),
  productFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findFirst: mocks.entityFindFirst },
    field: { findFirst: mocks.fieldFindFirst, findUnique: mocks.fieldFindUnique },
    domain: { findFirst: mocks.domainFindFirst },
    product: { findFirst: mocks.productFindFirst },
  },
}));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => db.activeTenantId }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/field-studio", () => ({
  FieldStudio: () => null,
}));

import FieldDetailPage from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/page";

function fieldRow(id: string, entityId: string, slug = "email") {
  const entity = db.entities.find((e) => e.id === entityId)!;
  return {
    id,
    slug,
    name: "Email",
    type: "string",
    precision: null,
    scale: null,
    nullable: true,
    isKey: false,
    fieldNumber: null,
    description: "",
    classification: null,
    aliases: [],
    decorators: {},
    entityId,
    entity: { ...entity, domain: null },
  };
}

function params(domainSlug: string, productSlug: string, entityId: string, fieldId: string) {
  return Promise.resolve({ domainSlug, productSlug, entityId, fieldId });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.activeTenantId = "tenant-1";
  db.entities = [];
  db.fields = [];
  db.domains = [];
  db.products = [];
  mocks.entityFindFirst.mockImplementation(findFirst(() => db.entities));
  mocks.domainFindFirst.mockImplementation(findFirst(() => db.domains));
  mocks.productFindFirst.mockImplementation(findFirst(() => db.products));
  mocks.fieldFindFirst.mockImplementation(findFirst(() => db.fields));
  mocks.fieldFindUnique.mockImplementation(async (args: { where: Row }) =>
    db.fields.find((f) => f.id === args.where.id) ?? null
  );
});

describe("FieldDetailPage for an Enterprise (tenant-level) entity", () => {
  const ENTERPRISE = ["enterprise", "entities"] as const;

  beforeEach(() => {
    // Another tenant's entity with the same slug comes FIRST, so an unscoped lookup finds it.
    db.entities = [
      { id: "ent-other-tenant", slug: "customer", tenantId: "tenant-2", domainId: null, productId: null, name: "Customer" },
      { id: "ent-product-twin", slug: "customer", tenantId: "tenant-1", domainId: "dom-1", productId: "prod-1", name: "Customer" },
      { id: "ent-t1", slug: "customer", tenantId: "tenant-1", domainId: null, productId: null, name: "Customer" },
    ];
    db.fields = [
      fieldRow("f-other", "ent-other-tenant"),
      fieldRow("f-product", "ent-product-twin"),
      fieldRow("f-t1", "ent-t1"),
    ];
  });

  it("resolves the active tenant's tenant-level entity even when other entities share the slug", async () => {
    const element = await FieldDetailPage({ params: params(...ENTERPRISE, "customer", "email") });

    expect(element.props.field.id).toBe("f-t1");
    // Tenant-level: null slugs (not the URL's "enterprise"/"entities" segments), so the
    // client builds its links with assetHref.
    expect(element.props.entity).toMatchObject({
      id: "ent-t1",
      slug: "customer",
      domainSlug: null,
      productSlug: null,
    });
    expect(mocks.entityFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: "customer", productId: null, domainId: null, tenantId: "tenant-1" },
      })
    );
  });

  it("404s when the active tenant has no Enterprise entity with that slug", async () => {
    db.activeTenantId = "tenant-3";

    await expect(
      FieldDetailPage({ params: params(...ENTERPRISE, "customer", "email") })
    ).rejects.toThrow("not found");
  });

  it("keeps the field/entity guard: a field of another entity 404s", async () => {
    db.fields.push({ ...fieldRow("f-stray", "ent-other-tenant", "stray") });

    await expect(
      FieldDetailPage({ params: params(...ENTERPRISE, "customer", "f-stray") })
    ).rejects.toThrow("not found");
  });
});

describe("FieldDetailPage for a product entity", () => {
  beforeEach(() => {
    db.domains = [{ id: "dom-1", slug: "payments", tenantId: "tenant-1" }];
    db.products = [
      { id: "prod-1", slug: "checkout", domainId: "dom-1" },
      { id: "prod-2", slug: "billing", domainId: "dom-1" },
    ];
    // Same slug in two products of one domain; the billing twin comes first.
    db.entities = [
      { id: "ent-billing", slug: "order", tenantId: "tenant-1", domainId: "dom-1", productId: "prod-2", name: "Order" },
      { id: "ent-checkout", slug: "order", tenantId: "tenant-1", domainId: "dom-1", productId: "prod-1", name: "Order" },
    ];
    db.fields = [fieldRow("f-billing", "ent-billing"), fieldRow("f-checkout", "ent-checkout")];
  });

  it("scopes the entity lookup to the URL's product", async () => {
    const element = await FieldDetailPage({ params: params("payments", "checkout", "order", "email") });

    expect(element.props.field.id).toBe("f-checkout");
    expect(element.props.entity).toMatchObject({ id: "ent-checkout", domainSlug: "payments", productSlug: "checkout" });
    expect(mocks.entityFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "order", productId: "prod-1", tenantId: "tenant-1" } })
    );
  });

  it("falls back to the entity id within the same product", async () => {
    const element = await FieldDetailPage({ params: params("payments", "checkout", "ent-checkout", "email") });

    expect(element.props.entity.id).toBe("ent-checkout");
  });

  it("does not resolve an entity that lives in a different product", async () => {
    await expect(
      FieldDetailPage({ params: params("payments", "checkout", "ent-billing", "email") })
    ).rejects.toThrow("not found");
  });

  it("404s for an unknown product or domain", async () => {
    await expect(
      FieldDetailPage({ params: params("payments", "nope", "order", "email") })
    ).rejects.toThrow("not found");
    await expect(
      FieldDetailPage({ params: params("nope", "checkout", "order", "email") })
    ).rejects.toThrow("not found");
  });
});
