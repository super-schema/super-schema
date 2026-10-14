import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEntityFindFirst } = vi.hoisted(() => ({ mockEntityFindFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { entity: { findFirst: mockEntityFindFirst } } }));

import { loadEntityWorkspace } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/load-entity-workspace";

function entityRow(over: Record<string, unknown> = {}) {
  return {
    id: "ent-1",
    name: "Order",
    slug: "order",
    description: "An order",
    status: "DRAFT",
    version: 2,
    domainId: "dom-1",
    productId: "prod-1",
    metadata: { owner: "x" },
    domain: { id: "dom-1", name: "Payments", slug: "payments", policyTemplate: { completenessRequirements: {} } },
    product: { slug: "checkout", name: "Checkout" },
    fields: [
      {
        id: "f1",
        slug: "order-id",
        name: "Order Id",
        type: "string",
        precision: null,
        scale: null,
        nullable: false,
        isKey: true,
        fieldNumber: null,
        description: "",
        classification: null,
        aliases: [],
        decorators: {},
        sortOrder: 0,
      },
    ],
    services: [
      {
        id: "svc-1",
        operations: [
          {
            id: "op-1",
            name: "getOrder",
            httpMethod: "GET",
            httpPath: "/orders/{id}",
            description: "",
            parameters: [{ name: "id", type: "string", location: "path", required: true, description: "" }],
            responses: [{ statusCode: 200, type: "Order", description: "ok" }],
          },
        ],
      },
    ],
    ...over,
  };
}

describe("loadEntityWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves by slug first, scoped by product and tenant", async () => {
    mockEntityFindFirst.mockResolvedValueOnce(entityRow());

    const data = await loadEntityWorkspace({ slugOrId: "order", productId: "prod-1", tenantId: "tenant-1" });

    expect(mockEntityFindFirst).toHaveBeenCalledTimes(1);
    expect(mockEntityFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "order", productId: "prod-1", tenantId: "tenant-1" } })
    );
    expect(data?.props.level).toBe("PRODUCT");
    expect(data?.props.entity).toMatchObject({
      id: "ent-1",
      domainId: "dom-1",
      domainName: "Payments",
      domainSlug: "payments",
      productSlug: "checkout",
      productName: "Checkout",
    });
    expect(data?.props.domainPolicy).toEqual({ completenessRequirements: {} });
    expect(data?.props.fields).toHaveLength(1);
    expect(data?.props.apiServiceId).toBe("svc-1");
    expect(data?.props.apiOperations).toEqual([
      expect.objectContaining({ id: "op-1", serviceId: "svc-1", name: "getOrder" }),
    ]);
  });

  it("falls back to the id, with the same product and tenant scope", async () => {
    mockEntityFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(entityRow());

    const data = await loadEntityWorkspace({ slugOrId: "cuid-123", productId: "prod-1", tenantId: "tenant-1" });

    expect(mockEntityFindFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { slug: "cuid-123", productId: "prod-1", tenantId: "tenant-1" } })
    );
    expect(mockEntityFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { id: "cuid-123", productId: "prod-1", tenantId: "tenant-1" } })
    );
    expect(data).not.toBeNull();
  });

  it("returns null when neither the slug nor the id matches", async () => {
    mockEntityFindFirst.mockResolvedValue(null);

    const data = await loadEntityWorkspace({ slugOrId: "missing", productId: "prod-1", tenantId: "tenant-1" });

    expect(mockEntityFindFirst).toHaveBeenCalledTimes(2);
    expect(data).toBeNull();
  });

  it("scopes a null productId to tenant-level entities and marks the level TENANT", async () => {
    mockEntityFindFirst.mockResolvedValueOnce(
      entityRow({ domainId: null, productId: null, domain: null, product: null, services: [] })
    );

    const data = await loadEntityWorkspace({ slugOrId: "order", productId: null, tenantId: "tenant-1" });

    expect(mockEntityFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "order", productId: null, domainId: null, tenantId: "tenant-1" } })
    );
    expect(data?.props.level).toBe("TENANT");
    expect(data?.props.entity).toMatchObject({
      domainId: null,
      domainName: "Enterprise",
      domainSlug: null,
      productSlug: null,
      productName: null,
    });
    expect(data?.props.domainPolicy).toBeNull();
    expect(data?.props.apiServiceId).toBeNull();
    expect(data?.props.apiOperations).toEqual([]);
  });

  it("also scopes the tenant id fallback to domainId null", async () => {
    mockEntityFindFirst.mockResolvedValue(null);

    await loadEntityWorkspace({ slugOrId: "cuid-123", productId: null, tenantId: "tenant-1" });

    expect(mockEntityFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { id: "cuid-123", productId: null, domainId: null, tenantId: "tenant-1" } })
    );
  });

  describe("deprecation replacement", () => {
    const deprecated = (replacementEntityId: string | null | undefined) =>
      entityRow({
        status: "DEPRECATED",
        metadata: { deprecation: { deprecated: true, since: "2026-01-01", replacementEntityId } },
      });

    it("resolves a product replacement's slugs within the same tenant", async () => {
      mockEntityFindFirst
        .mockResolvedValueOnce(deprecated("ent-2"))
        .mockResolvedValueOnce({
          name: "Order v2",
          slug: "order-v2",
          domain: { slug: "payments" },
          product: { slug: "checkout" },
        });

      const data = await loadEntityWorkspace({ slugOrId: "order", productId: "prod-1", tenantId: "tenant-1" });

      expect(mockEntityFindFirst).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ where: { id: "ent-2", tenantId: "tenant-1" } })
      );
      expect(data?.props.replacementEntity).toEqual({
        name: "Order v2",
        slug: "order-v2",
        domainSlug: "payments",
        productSlug: "checkout",
      });
    });

    it("carries null slugs for a tenant-level replacement", async () => {
      mockEntityFindFirst
        .mockResolvedValueOnce(deprecated("ent-2"))
        .mockResolvedValueOnce({ name: "Customer v2", slug: "customer-v2", domain: null, product: null });

      const data = await loadEntityWorkspace({ slugOrId: "order", productId: "prod-1", tenantId: "tenant-1" });

      expect(data?.props.replacementEntity).toEqual({
        name: "Customer v2",
        slug: "customer-v2",
        domainSlug: null,
        productSlug: null,
      });
    });

    it("yields null when the replacement entity cannot be found", async () => {
      mockEntityFindFirst.mockResolvedValueOnce(deprecated("ent-gone")).mockResolvedValueOnce(null);

      const data = await loadEntityWorkspace({ slugOrId: "order", productId: "prod-1", tenantId: "tenant-1" });

      expect(data?.props.replacementEntity).toBeNull();
    });

    it("does not look anything up when no replacement is named or the entity is not deprecated", async () => {
      mockEntityFindFirst.mockResolvedValueOnce(deprecated(null));
      const none = await loadEntityWorkspace({ slugOrId: "order", productId: "prod-1", tenantId: "tenant-1" });
      expect(none?.props.replacementEntity).toBeNull();

      mockEntityFindFirst.mockClear();
      mockEntityFindFirst.mockResolvedValueOnce(
        entityRow({ metadata: { deprecation: { deprecated: true, replacementEntityId: "ent-2" } } })
      );
      const active = await loadEntityWorkspace({ slugOrId: "order", productId: "prod-1", tenantId: "tenant-1" });
      expect(active?.props.replacementEntity).toBeNull();
      expect(mockEntityFindFirst).toHaveBeenCalledTimes(1);
    });
  });
});
