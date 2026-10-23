import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockPrisma, mockTx, mockAssertNameAvailable, mockEnsureDefaultProductId } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    product: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    domain: {
      findUnique: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  mockTx: {
    entity: {
      create: vi.fn(),
    },
  },
  mockAssertNameAvailable: vi.fn(),
  mockEnsureDefaultProductId: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

vi.mock("@/lib/org-defaults", () => ({
  ensureDefaultProductId: mockEnsureDefaultProductId,
}));

vi.mock("@/services/name-registry.service", () => ({
  assertNameAvailable: mockAssertNameAvailable,
  withTenantNameLock: (_db: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
}));

import { createEntityWithFieldsAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";

const PRODUCT_SCOPE = { tenantId: "tenant-1", domainId: "domain-1", productId: "prd-default" };

describe("createEntityWithFieldsAction session reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: "stale-user-id", email: "owner@example.com" },
    });
    mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
    mockPrisma.domain.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockPrisma.product.findUnique.mockResolvedValue({
      id: "prd-default",
      domainId: "domain-1",
      domain: { tenantId: "tenant-1" },
    });
    mockPrisma.product.create.mockResolvedValue({ id: "prd-default" });
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
    mockTx.entity.create.mockResolvedValue({ id: "entity-1" });
    mockEnsureDefaultProductId.mockResolvedValue("prd-default");
  });

  it("uses the current user row when the session id is stale but email still matches", async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "current-user-id" })
      .mockResolvedValueOnce({ id: "current-user-id" });

    const result = await createEntityWithFieldsAction("domain-1", {
      name: "Customer",
      description: "Customer entity",
      fields: [],
    });

    expect(result).toEqual({ success: true, entityId: "entity-1" });
    expect(mockPrisma.user.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "stale-user-id" },
      select: { id: true },
    });
    expect(mockPrisma.user.findUnique).toHaveBeenNthCalledWith(2, {
      where: { email: "owner@example.com" },
      select: { id: true },
    });
    expect(mockTx.entity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownerId: "current-user-id", tenantId: "tenant-1" }),
      })
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "current-user-id" }),
      })
    );
  });

  it("stores the entity-level vendor extensions of a single-entity import at metadata.custom.extensions", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    const result = await createEntityWithFieldsAction("domain-1", {
      name: "Device",
      description: "",
      fields: [],
      extensions: { "x-team": "iot", "x-lifecycle": { stage: "beta" } },
    });
    expect(result).toEqual({ success: true, entityId: "entity-1" });
    expect(mockTx.entity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ metadata: { custom: { extensions: { "x-team": "iot", "x-lifecycle": { stage: "beta" } } } } }),
      })
    );
  });

  it("writes no metadata for an entity without extensions (and ignores a malformed extensions payload)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    await createEntityWithFieldsAction("domain-1", { name: "Plain", description: "", fields: [], extensions: ["x"] as never });
    const data = mockTx.entity.create.mock.calls.at(-1)?.[0].data;
    expect(data).not.toHaveProperty("metadata");
  });

  describe("name registry and placement", () => {
    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    });

    it("checks the trimmed name against the product-level scope before creating", async () => {
      const result = await createEntityWithFieldsAction("domain-1", {
        name: "  Customer ",
        description: "",
        fields: [],
      });

      expect(result).toEqual({ success: true, entityId: "entity-1" });
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "Customer", ...PRODUCT_SCOPE });
      expect(mockTx.entity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: "Customer", ...PRODUCT_SCOPE }),
      });
    });

    it("returns the registry conflict message, creates nothing and writes no audit log", async () => {
      mockAssertNameAvailable.mockResolvedValue({
        success: false,
        error: { code: "NAME_CONFLICT", message: "dup" },
      });

      const result = await createEntityWithFieldsAction("domain-1", {
        name: "Customer",
        description: "",
        fields: [],
      });

      expect(result).toEqual({ error: "dup" });
      expect(mockTx.entity.create).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("places the entity in an explicitly requested product", async () => {
      mockPrisma.product.findUnique.mockResolvedValue({
        id: "prd-2",
        domainId: "domain-1",
        domain: { tenantId: "tenant-1" },
      });

      await createEntityWithFieldsAction("domain-1", { name: "Customer", description: "", fields: [] }, "prd-2");

      expect(mockPrisma.product.create).not.toHaveBeenCalled();
      expect(mockTx.entity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ...PRODUCT_SCOPE, productId: "prd-2" }),
      });
    });

    it("rejects a product that belongs to a different domain", async () => {
      mockPrisma.product.findUnique.mockResolvedValue({
        id: "prd-2",
        domainId: "other-domain",
        domain: { tenantId: "tenant-1" },
      });

      const result = await createEntityWithFieldsAction(
        "domain-1",
        { name: "Customer", description: "", fields: [] },
        "prd-2"
      );

      expect(result).toEqual({ error: "Product does not belong to this domain" });
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
      expect(mockTx.entity.create).not.toHaveBeenCalled();
    });

    it("rejects an entity named 'Events' (reserved URL segment)", async () => {
      const result = await createEntityWithFieldsAction("domain-1", {
        name: "Events",
        description: "",
        fields: [],
      });

      expect(result).toEqual({
        error: expect.stringContaining("events"),
      });
      expect(mockEnsureDefaultProductId).not.toHaveBeenCalled();
      expect(mockTx.entity.create).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
