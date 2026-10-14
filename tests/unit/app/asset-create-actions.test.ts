import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockPrisma, mockTx, mockAssertNameAvailable } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    domain: { findUnique: vi.fn() },
    product: { findUnique: vi.fn() },
    entity: { findUnique: vi.fn() },
    serviceDefinition: { findFirst: vi.fn() },
  },
  mockTx: {
    sharedEnum: { create: vi.fn() },
    customScalar: { create: vi.fn() },
    unionType: { create: vi.fn() },
    serviceDefinition: { create: vi.fn() },
  },
  mockAssertNameAvailable: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/services/name-registry.service", () => ({
  assertNameAvailable: mockAssertNameAvailable,
  withTenantNameLock: (_db: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
}));

import {
  createSharedEnumAction,
  createCustomScalarAction,
  createUnionTypeAction,
  createServiceAction,
  getOrCreateEntityServiceAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/actions";

const DOMAIN_SCOPE = { tenantId: "tenant-1", domainId: "domain-1", productId: null };
const PRODUCT_SCOPE = { tenantId: "tenant-1", domainId: "domain-1", productId: "prd-1" };
const CONFLICT = { success: false, error: { code: "NAME_CONFLICT", message: "dup" } };

describe("level-aware data type and API creates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrisma.domain.findUnique.mockResolvedValue({ id: "domain-1", tenantId: "tenant-1" });
    mockPrisma.product.findUnique.mockResolvedValue({
      id: "prd-1",
      domainId: "domain-1",
      domain: { tenantId: "tenant-1" },
    });
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
    mockTx.sharedEnum.create.mockResolvedValue({ id: "enum-1" });
    mockTx.customScalar.create.mockResolvedValue({ id: "scalar-1" });
    mockTx.unionType.create.mockResolvedValue({ id: "union-1" });
    mockTx.serviceDefinition.create.mockResolvedValue({ id: "svc-1" });
  });

  describe("createSharedEnumAction", () => {
    it("checks the registry then creates at domain level by default", async () => {
      const result = await createSharedEnumAction("domain-1", { name: "Status", values: ["A", "B"] });

      expect(result).toEqual({ success: true });
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "Status", ...DOMAIN_SCOPE });
      expect(mockTx.sharedEnum.create).toHaveBeenCalledWith({
        data: { name: "Status", values: ["A", "B"], description: "", ...DOMAIN_SCOPE },
      });
    });

    it("creates at the requested target level", async () => {
      await createSharedEnumAction("domain-1", { name: "Status", values: [] }, { level: "PRODUCT", productId: "prd-1" });
      expect(mockTx.sharedEnum.create).toHaveBeenCalledWith({
        data: expect.objectContaining(PRODUCT_SCOPE),
      });
    });

    it("creates at tenant level without any domain lookup", async () => {
      await createSharedEnumAction("domain-1", { name: "Status", values: [] }, { level: "TENANT", tenantId: "tenant-1" });
      expect(mockPrisma.domain.findUnique).not.toHaveBeenCalled();
      expect(mockTx.sharedEnum.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ tenantId: "tenant-1", domainId: null, productId: null }),
      });
    });

    it("returns the registry conflict message and does not create", async () => {
      mockAssertNameAvailable.mockResolvedValue(CONFLICT);
      const result = await createSharedEnumAction("domain-1", { name: "Status", values: [] });
      expect(result).toEqual({ error: "dup" });
      expect(mockTx.sharedEnum.create).not.toHaveBeenCalled();
    });

    it("returns NOT_FOUND message when the target does not resolve", async () => {
      mockPrisma.domain.findUnique.mockResolvedValue(null);
      const result = await createSharedEnumAction("nope", { name: "Status", values: [] });
      expect(result).toEqual({ error: 'Domain "nope" not found' });
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    });
  });

  describe("createCustomScalarAction", () => {
    it("checks the registry then creates", async () => {
      const result = await createCustomScalarAction("domain-1", { name: "Money", baseType: "decimal" });
      expect(result).toEqual({ success: true });
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "Money", ...DOMAIN_SCOPE });
      expect(mockTx.customScalar.create).toHaveBeenCalledWith({
        data: { name: "Money", baseType: "decimal", format: null, pattern: null, description: "", ...DOMAIN_SCOPE },
      });
    });

    it("returns the registry conflict message and does not create", async () => {
      mockAssertNameAvailable.mockResolvedValue(CONFLICT);
      const result = await createCustomScalarAction("domain-1", { name: "Money", baseType: "decimal" });
      expect(result).toEqual({ error: "dup" });
      expect(mockTx.customScalar.create).not.toHaveBeenCalled();
    });
  });

  describe("createUnionTypeAction", () => {
    it("checks the registry then creates", async () => {
      const result = await createUnionTypeAction("domain-1", { name: "Either", memberTypes: ["A", "B"] });
      expect(result).toEqual({ success: true });
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "Either", ...DOMAIN_SCOPE });
      expect(mockTx.unionType.create).toHaveBeenCalledWith({
        data: { name: "Either", memberTypes: ["A", "B"], description: "", ...DOMAIN_SCOPE },
      });
    });

    it("returns the registry conflict message and does not create", async () => {
      mockAssertNameAvailable.mockResolvedValue(CONFLICT);
      const result = await createUnionTypeAction("domain-1", { name: "Either", memberTypes: [] });
      expect(result).toEqual({ error: "dup" });
      expect(mockTx.unionType.create).not.toHaveBeenCalled();
    });
  });

  describe("createServiceAction", () => {
    it("creates at domain level by default and returns the service id", async () => {
      const result = await createServiceAction("domain-1", { name: " OrdersApi ", scope: "DOMAIN" });
      expect(result).toEqual({ success: true, serviceId: "svc-1" });
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "OrdersApi", ...DOMAIN_SCOPE });
      expect(mockTx.serviceDefinition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: "OrdersApi", scope: "DOMAIN", basePath: "/", ...DOMAIN_SCOPE }),
      });
    });

    it("accepts a product-level target", async () => {
      await createServiceAction(
        "domain-1",
        { name: "OrdersApi", scope: "DOMAIN" },
        { level: "PRODUCT", productId: "prd-1" }
      );
      expect(mockTx.serviceDefinition.create).toHaveBeenCalledWith({
        data: expect.objectContaining(PRODUCT_SCOPE),
      });
    });

    it("rejects tenant level (APIs are domain or product only) before any registry call", async () => {
      const result = await createServiceAction(
        "domain-1",
        { name: "OrdersApi", scope: "DOMAIN" },
        { level: "TENANT", tenantId: "tenant-1" }
      );
      expect(result).toEqual({ error: expect.stringContaining("API cannot be defined at Enterprise level") });
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
      expect(mockTx.serviceDefinition.create).not.toHaveBeenCalled();
    });

    it("returns the registry conflict message and does not create", async () => {
      mockAssertNameAvailable.mockResolvedValue(CONFLICT);
      const result = await createServiceAction("domain-1", { name: "OrdersApi", scope: "DOMAIN" });
      expect(result).toEqual({ error: "dup" });
      expect(mockTx.serviceDefinition.create).not.toHaveBeenCalled();
    });
  });

  describe("createServiceAction with scope ENTITY", () => {
    it("derives the product-level target from the entity, ignoring any passed target", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: "prd-1" });

      const result = await createServiceAction(
        "domain-1",
        { name: "OrderApi", scope: "ENTITY", entityId: "ent-1" },
        { level: "DOMAIN", domainId: "domain-1" }
      );

      expect(result).toEqual({ success: true, serviceId: "svc-1" });
      expect(mockPrisma.entity.findUnique).toHaveBeenCalledWith({
        where: { id: "ent-1" },
        select: { id: true, productId: true },
      });
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "OrderApi", ...PRODUCT_SCOPE });
      expect(mockTx.serviceDefinition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ scope: "ENTITY", entityId: "ent-1", ...PRODUCT_SCOPE }),
      });
    });

    it("refuses tenant-level (Enterprise) entities", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: null });
      const result = await createServiceAction("domain-1", { name: "OrderApi", scope: "ENTITY", entityId: "ent-1" });
      expect(result).toEqual({ error: "Enterprise entities cannot own APIs" });
      expect(mockTx.serviceDefinition.create).not.toHaveBeenCalled();
    });

    it("returns an error for an unknown entity", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue(null);
      const result = await createServiceAction("domain-1", { name: "OrderApi", scope: "ENTITY", entityId: "ent-1" });
      expect(result).toEqual({ error: "Entity not found" });
      expect(mockTx.serviceDefinition.create).not.toHaveBeenCalled();
    });

    it("requires an entity id", async () => {
      const result = await createServiceAction("domain-1", { name: "OrderApi", scope: "ENTITY" });
      expect(result).toEqual({ error: "Select an entity for an entity-scoped API" });
      expect(mockPrisma.entity.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("getOrCreateEntityServiceAction", () => {
    beforeEach(() => {
      mockPrisma.serviceDefinition.findFirst.mockResolvedValue(null);
    });

    it("returns the existing service without touching the registry", async () => {
      mockPrisma.serviceDefinition.findFirst.mockResolvedValue({ id: "svc-existing" });
      const result = await getOrCreateEntityServiceAction("domain-1", "ent-1", "Order");
      expect(result).toEqual({ success: true, serviceId: "svc-existing" });
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    });

    it("refuses tenant-level (Enterprise) entities", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: null });
      const result = await getOrCreateEntityServiceAction("domain-1", "ent-1", "Order");
      expect(result).toEqual({ error: "Enterprise entities cannot own APIs" });
      expect(mockTx.serviceDefinition.create).not.toHaveBeenCalled();
    });

    it("creates the service at the product-level scope of a product entity", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: "prd-1" });
      const result = await getOrCreateEntityServiceAction("domain-1", "ent-1", "Order");
      expect(result).toEqual({ success: true, serviceId: "svc-1" });
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "OrderApi", ...PRODUCT_SCOPE });
      expect(mockTx.serviceDefinition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "OrderApi",
          scope: "ENTITY",
          entityId: "ent-1",
          ...PRODUCT_SCOPE,
        }),
      });
    });

    it("returns the registry conflict message and does not create", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: "prd-1" });
      mockAssertNameAvailable.mockResolvedValue(CONFLICT);
      const result = await getOrCreateEntityServiceAction("domain-1", "ent-1", "Order");
      expect(result).toEqual({ error: "dup" });
      expect(mockTx.serviceDefinition.create).not.toHaveBeenCalled();
    });

    it("returns an error when the entity does not exist", async () => {
      mockPrisma.entity.findUnique.mockResolvedValue(null);
      const result = await getOrCreateEntityServiceAction("domain-1", "ent-1", "Order");
      expect(result).toEqual({ error: "Entity not found" });
    });
  });
});
