import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionPrincipalModule } from "../../helpers/access-mocks";

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

vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
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

  it("refuses a user who is nobody (a stale session id, a disabled user: the principal loader finds no active user BY ID, and never by e-mail), creating and auditing nothing", async () => {
    // The by-id, no-e-mail-fallback and disabled rules themselves are pinned in tests/unit/lib/access/principal.test.ts; here the action must
    // stop at "nobody" before it writes.
    sessionPrincipalModule.getPrincipal.mockResolvedValueOnce(null);
    const stale = await createEntityWithFieldsAction("domain-1", { name: "Customer", description: "Customer entity", fields: [] });
    sessionPrincipalModule.getPrincipal.mockResolvedValueOnce(null);
    const disabled = await createEntityWithFieldsAction("domain-1", { name: "Customer", description: "Customer entity", fields: [] });

    expect(stale).toEqual({ error: "You must be logged in", code: "UNAUTHORIZED" });
    expect(disabled).toEqual(stale);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockTx.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
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

  describe("a precision or scale the database cannot hold is a validation error, not an unexpected failure", () => {
    const decimalField = (precision: unknown, scale: unknown) =>
      ({ name: "total", type: "decimal", nullable: true, isKey: false, description: "", classification: null, precision, scale }) as never;

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    });

    it.each([
      ["a precision beyond a 32-bit integer", 99_999_999_999, 2],
      ["a scale beyond a 32-bit integer", 12, 2 ** 31],
      ["a negative precision", -1, 0],
      ["a fractional scale", 12, 0.5],
      ["a precision that is a string", "12", 2],
      ["Infinity", Infinity, 2],
      ["NaN", 12, Number.NaN],
    ])("refuses %s, names the field, and creates nothing", async (_name, precision, scale) => {
      const result = await createEntityWithFieldsAction("domain-1", { name: "Ledger", description: "", fields: [decimalField(precision, scale)] });
      expect(result).toEqual({ error: expect.stringContaining('"total"'), code: "VALIDATION_ERROR" });
      expect(mockTx.entity.create).not.toHaveBeenCalled();
    });

    it("accepts none, null, and a whole pair", async () => {
      for (const [precision, scale] of [[null, null], [undefined, undefined], [12, 2], [0, 0]] as const) {
        const result = await createEntityWithFieldsAction("domain-1", { name: "Ledger", description: "", fields: [decimalField(precision, scale)] });
        expect(result).toEqual({ success: true, entityId: "entity-1" });
      }
    });
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

    it.each(["url", "int32", "Duration", "String", "bool"])("rejects an entity named '%s' (a built-in type name) before any database work", async (name) => {
      const result = await createEntityWithFieldsAction("domain-1", { name, description: "", fields: [] });

      expect(result).toEqual({ error: expect.stringContaining("is a built-in type name") });
      expect((result as { error: string }).error).toContain(`"${name}"`);
      expect(mockEnsureDefaultProductId).not.toHaveBeenCalled();
      expect(mockTx.entity.create).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
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
