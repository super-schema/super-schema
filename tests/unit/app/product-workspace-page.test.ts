import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, signInAs } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  loadEventsList: vi.fn(),
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
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.getActiveTenantId, requireActiveTenantId: mocks.getActiveTenantId, NO_ACCESS_PATH: "/no-access" }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/features/events/event-page/load-events-list", () => ({ loadEventsList: mocks.loadEventsList }));
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
  signInAs(globalAdmin());
  mocks.loadEventsList.mockResolvedValue([]);
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
    // Deleting a domain is a feature of the Domains page (DomainGrid); the product page has no such prop.
    expect(element.props.canDeleteDomain).toBeUndefined();
    expect(element.props.isSystemDomain).toBeUndefined();
    expect(element.props).toMatchObject({
      domainId: "dom-1",
      productId: "prod-1",
      productName: "Checkout",
      domainSlug: "payments",
      productSlug: "checkout",
    });
  });

  it("loads the events list for the resolved tenant, product, domain slug and product slug, and passes it on", async () => {
    const events = [
      {
        id: "ev1", name: "orders", specType: "asyncapi@3.0", versionLabel: null, hasUnpublishedChanges: true,
        channels: 1, messages: 2, operations: 1, href: "/schemas/payments/checkout/events/ev1",
      },
    ];
    mocks.loadEventsList.mockResolvedValue(events);

    const element = await ProductWorkspacePage({ params });

    expect(mocks.loadEventsList).toHaveBeenCalledTimes(1);
    expect(mocks.loadEventsList).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      productId: "prod-1",
      domainSlug: "payments",
      productSlug: "checkout",
    });
    expect(element.props.events).toBe(events);
  });

  it("passes the product's contacts to the workspace header", async () => {
    mocks.domainFindFirst.mockResolvedValue({
      ...DOMAIN,
      products: [
        {
          id: "prod-1",
          name: "Checkout",
          slug: "checkout",
          engineeringLead: '"Doe, Jane" <j@x.com>',
          manager: "mo@acme.com",
          teamEmails: ["Platform <platform@acme.com>"],
        },
      ],
    });

    const element = await ProductWorkspacePage({ params });

    expect(element.props.productContacts).toEqual({
      engineeringLead: '"Doe, Jane" <j@x.com>',
      manager: "mo@acme.com",
      teamEmails: ["Platform <platform@acme.com>"],
    });
  });

  it("passes empty contacts for a product that has none (the header shows nothing)", async () => {
    // The default fixture product has no contact columns at all (a row read before the migration, or a bare mock).
    const element = await ProductWorkspacePage({ params });

    expect(element.props.productContacts).toEqual({ engineeringLead: null, manager: null, teamEmails: [] });
  });

  it("passes an empty list for a product without events (the list shows its empty state)", async () => {
    const element = await ProductWorkspacePage({ params });
    expect(element.props.events).toEqual([]);
  });

  it("no longer loads or passes the old messages / channels / specs / traits tab data", async () => {
    const element = await ProductWorkspacePage({ params });
    expect(element.props.traits).toBeUndefined();
    expect(element.props.events).not.toHaveProperty("eventSpecs");
    expect(element.props.events).not.toHaveProperty("payloadEntities");
  });

  it("does not load events data for a legacy entity redirect or a 404", async () => {
    mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, products: [] });
    mocks.entityFindFirst.mockResolvedValue(null);
    await expect(ProductWorkspacePage({ params })).rejects.toThrow("not found");
    expect(mocks.loadEventsList).not.toHaveBeenCalled();
  });

  it("never looks a domain up outside the tenant in view: a slug that only another tenant has is a 404 (there is no tenant-agnostic fallback)", async () => {
    mocks.domainFindFirst.mockImplementation(async ({ where }: { where: { tenantId?: string } }) => (where.tenantId === "tenant-1" ? null : DOMAIN));
    await expect(ProductWorkspacePage({ params })).rejects.toThrow("not found");

    expect(mocks.domainFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.domainFindFirst.mock.calls[0][0].where).toEqual({ slug: "payments", tenantId: "tenant-1" });
    expect(mocks.entityFindMany).not.toHaveBeenCalled();
  });

  it("404s when the domain does not exist", async () => {
    mocks.domainFindFirst.mockResolvedValue(null);
    await expect(ProductWorkspacePage({ params })).rejects.toThrow("not found");
  });

  it("redirects a legacy 2-segment entity link to the canonical entity URL, keeping the query", async () => {
    mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, products: [] });
    mocks.entityFindFirst.mockResolvedValue({ slug: "checkout", productId: "prod-9", product: { slug: "web" } });

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

// Who may open a product (a role over the product, its domain, the tenant or the platform) and how much of what it inherits it is shown.
describe("ProductWorkspacePage: who may see what", () => {
  it.each([
    ["a viewer of the tenant", [assign.tenant("VIEWER", "tenant-1")]],
    ["an author of the domain", [assign.domain("AUTHOR", "tenant-1", "dom-1")]],
    ["a viewer of exactly this product", [assign.product("VIEWER", "tenant-1", "dom-1", "prod-1")]],
  ])("%s opens it", async (_who, assignments) => {
    signInAs(principalOf(assignments));
    const element = await ProductWorkspacePage({ params });
    expect(element.props.entities).toHaveLength(2);
  });

  it.each([
    ["an author of ANOTHER product of the domain", [assign.product("AUTHOR", "tenant-1", "dom-1", "prod-2")]],
    ["an author of another domain", [assign.domain("AUTHOR", "tenant-1", "dom-2")]],
    ["an administrator of another tenant", [assign.tenant("ADMIN", "tenant-2")]],
    ["a user with no role", []],
  ])("%s gets a 404 and no content is read", async (_who, assignments) => {
    signInAs(principalOf(assignments));
    await expect(ProductWorkspacePage({ params })).rejects.toThrow("not found");
    expect(mocks.entityFindMany).not.toHaveBeenCalled();
    expect(mocks.loadEventsList).not.toHaveBeenCalled();
  });

  it("a role at this product alone is not shown what the domain and the Enterprise hold: those queries are not run", async () => {
    signInAs(principalOf([assign.product("VIEWER", "tenant-1", "dom-1", "prod-1")]));
    mocks.empty.mockClear();
    await ProductWorkspacePage({ params });
    // the product's own four (enums, scalars, unions, APIs) only: the four of the domain and the three of the Enterprise are not asked for
    expect(mocks.empty).toHaveBeenCalledTimes(4);
  });

  it("a role over the whole tenant is shown the inherited assets too (all eleven queries run)", async () => {
    signInAs(principalOf([assign.tenant("VIEWER", "tenant-1")]));
    mocks.empty.mockClear();
    await ProductWorkspacePage({ params });
    expect(mocks.empty).toHaveBeenCalledTimes(11);
  });

  it("a legacy entity link redirects only to an entity the caller may read (the redirect would say that it exists): another product's entity is a 404", async () => {
    signInAs(principalOf([assign.product("VIEWER", "tenant-1", "dom-1", "prod-1")]));
    mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, products: [] });
    mocks.entityFindFirst.mockResolvedValue({ slug: "checkout", productId: "prod-9", product: { slug: "web" } });
    await expect(ProductWorkspacePage({ params })).rejects.toThrow("not found");
    // while an entity of the product the caller holds is followed
    mocks.entityFindFirst.mockResolvedValue({ slug: "checkout", productId: "prod-1", product: { slug: "web" } });
    await expect(ProductWorkspacePage({ params })).rejects.toThrow("redirect:/schemas/payments/web/checkout");
  });
});
