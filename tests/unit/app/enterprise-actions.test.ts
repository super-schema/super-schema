import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockPrisma, mockTx, mockAssertNameAvailable, mockGetActiveTenantId } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockTx: {
    entity: { create: vi.fn(), findFirst: vi.fn() },
  },
  mockAssertNameAvailable: vi.fn(),
  mockGetActiveTenantId: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));
vi.mock("@/services/name-registry.service", () => ({
  assertNameAvailable: mockAssertNameAvailable,
  withTenantNameLock: (_db: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
}));

import { createTenantEntityAction } from "@/app/(dashboard)/schemas/enterprise/actions";

const TENANT_SCOPE = { tenantId: "tenant-1", domainId: null, productId: null };

describe("createTenantEntityAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "owner@example.com" } });
    mockGetActiveTenantId.mockResolvedValue("tenant-1");
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
    mockTx.entity.findFirst.mockResolvedValue(null);
    mockTx.entity.create.mockResolvedValue({ id: "entity-1", slug: "customer" });
  });

  it("creates the entity with domainId and productId null in the active tenant", async () => {
    const result = await createTenantEntityAction({
      name: "  Customer ",
      description: "Shared customer",
      fields: [
        {
          name: "Customer Id",
          type: "string",
          nullable: false,
          isKey: true,
          description: "",
          classification: null,
          precision: null,
          scale: null,
        },
      ],
    });

    expect(result).toEqual({ success: true, entity: { id: "entity-1", slug: "customer" } });
    expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "Customer", ...TENANT_SCOPE });
    expect(mockTx.entity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Customer",
        slug: "customer",
        description: "Shared customer",
        ownerId: "user-1",
        ...TENANT_SCOPE,
        fields: {
          create: [expect.objectContaining({ name: "Customer Id", slug: "customer-id", sortOrder: 0, isKey: true })],
        },
      }),
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entityType: "Entity", action: "CREATE", userId: "user-1" }) })
    );
  });

  it("ignores any client-supplied tenantId and creates under the server-resolved active tenant", async () => {
    mockGetActiveTenantId.mockResolvedValue("tenant-1");

    await createTenantEntityAction({
      name: "Customer",
      description: "",
      fields: [],
      tenantId: "foreign-tenant",
    } as never);

    expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "Customer", ...TENANT_SCOPE });
    expect(mockTx.entity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "tenant-1", domainId: null, productId: null }),
    });
  });

  it("rejects an entity named 'Events' (reserved URL segment) before any database work", async () => {
    const result = await createTenantEntityAction({ name: "Events", description: "", fields: [] });

    expect(result).toEqual({ error: expect.stringContaining("events") });
    expect(mockGetActiveTenantId).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    expect(mockTx.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("returns the registry conflict message, creates nothing and writes no audit log", async () => {
    mockAssertNameAvailable.mockResolvedValue({
      success: false,
      error: { code: "NAME_CONFLICT", message: "dup" },
    });

    const result = await createTenantEntityAction({ name: "Customer", description: "", fields: [] });

    expect(result).toEqual({ error: "dup" });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects a name whose slug is already taken by an Enterprise entity", async () => {
    mockTx.entity.findFirst.mockResolvedValue({ id: "entity-0", name: "customer" });

    const result = await createTenantEntityAction({ name: "Customer", description: "", fields: [] });

    expect(result).toEqual({ error: expect.stringContaining("customer") });
    expect(mockTx.entity.findFirst).toHaveBeenCalledWith({
      where: { ...TENANT_SCOPE, slug: "customer" },
      select: { id: true },
    });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await createTenantEntityAction({ name: "Customer", description: "", fields: [] });

    expect(result).toEqual({ error: "You must be logged in" });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });

  it("requires a name", async () => {
    const result = await createTenantEntityAction({ name: "   ", description: "", fields: [] });

    expect(result).toEqual({ error: "Entity name is required" });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });

  it("asks for a fresh sign-in when the session user no longer exists", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const result = await createTenantEntityAction({ name: "Customer", description: "", fields: [] });

    expect(result).toEqual({ error: expect.stringContaining("session is stale") });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });
});
