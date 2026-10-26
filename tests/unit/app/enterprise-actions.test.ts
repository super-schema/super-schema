import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, resetSessionPrincipal, setSessionPrincipal } from "../../helpers/access-mocks";

const { mockAuth, mockPrisma, mockTx, mockAssertNameAvailable, mockGetActiveTenantId, mockEntityFindUnique } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockEntityFindUnique: vi.fn(),
  mockPrisma: {
    tenant: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    entity: { findUnique: (...args: unknown[]) => mockEntityFindUnique(...args) },
  },
  mockTx: {
    entity: { create: vi.fn(), findFirst: vi.fn() },
  },
  mockAssertNameAvailable: vi.fn(),
  mockGetActiveTenantId: vi.fn(),
}));

vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
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
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
    mockTx.entity.findFirst.mockResolvedValue(null);
    mockTx.entity.create.mockResolvedValue({ id: "entity-1", slug: "customer" });
  });

  it("refuses a precision or scale the database cannot hold, names the field, and creates nothing", async () => {
    const result = await createTenantEntityAction({
      name: "Ledger",
      description: "",
      fields: [{ name: "total", type: "decimal", nullable: true, isKey: false, description: "", classification: null, precision: 99_999_999_999, scale: 2 }],
    });
    expect(result).toEqual({ error: expect.stringContaining('"total"') });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
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

  it.each(["url", "int32", "Duration", "String"])("rejects a tenant entity named '%s' (a built-in type name) before any database work", async (name) => {
    const result = await createTenantEntityAction({ name, description: "", fields: [] });

    expect(result).toEqual({ error: expect.stringContaining(`"${name}" is a built-in type name`) });
    expect(mockGetActiveTenantId).not.toHaveBeenCalled();
    expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    expect(mockTx.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
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

  it("a payload with no usable name (null, a non-string name) is a validation message, not a TypeError before the try", async () => {
    for (const bad of [null, undefined, { name: 5, description: "", fields: [] }, { description: "", fields: [] }]) {
      expect(await createTenantEntityAction(bad as never)).toEqual({ error: "Entity name is required" });
    }
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });

  it("answers an unexpected failure with the generic message, never the driver text (path + source excerpt)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockTx.entity.create.mockRejectedValue(
      new Error("Invalid `prisma.entity.create()` invocation in\n/Users/dev/src/my/super-schema/src/app/enterprise/actions.ts:80:20\n→ 80 tx.entity.create({ data: { name: undefined")
    );

    const result = (await createTenantEntityAction({ name: "Customer", description: "", fields: [] })) as { error: string };

    expect(result.error).toBe("Something went wrong. Try again; if it keeps happening, contact an administrator.");
    expect(result.error).not.toMatch(/prisma|Users\/dev|actions\.ts/i);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("createTenantEntityAction: who may create a tenant-level entity (entity.write over the ACTIVE tenant itself)", () => {
  const create = () => createTenantEntityAction({ name: "Customer", description: "", fields: [] });

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionPrincipal();
    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "owner@example.com" } });
    mockGetActiveTenantId.mockResolvedValue("tenant-1");
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
    mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
    mockTx.entity.findFirst.mockResolvedValue(null);
    mockTx.entity.create.mockResolvedValue({ id: "entity-1", slug: "customer" });
  });

  it("answers nobody signed in 'You must be logged in' and creates nothing", async () => {
    mockAuth.mockResolvedValue(null);
    expect(await create()).toEqual({ error: "You must be logged in" });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });

  it("a user with no role and a viewer cannot create one (not found / generic refusal), and nothing is created or audited", async () => {
    setSessionPrincipal([]);
    expect(await create()).toEqual({ error: "Tenant not found" });
    setSessionPrincipal([assign.tenant("VIEWER", "tenant-1")]);
    expect(await create()).toEqual({ error: "You do not have permission to do this" });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("an author, steward and administrator of the TENANT can, and so can a platform administrator", async () => {
    for (const assignments of [[assign.tenant("AUTHOR", "tenant-1")], [assign.tenant("STEWARD", "tenant-1")], [assign.tenant("ADMIN", "tenant-1")], [assign.global()]]) {
      setSessionPrincipal(assignments);
      expect(await create(), JSON.stringify(assignments)).toEqual({ success: true, entity: { id: "entity-1", slug: "customer" } });
    }
  });

  it("a domain- or product-scoped author does NOT reach the tenant level: refused as a missing tenant, nothing created", async () => {
    for (const assignments of [[assign.domain("ADMIN", "tenant-1", "dom-a")], [assign.product("ADMIN", "tenant-1", "dom-a", "prod-a")]]) {
      setSessionPrincipal(assignments);
      expect(await create(), JSON.stringify(assignments)).toEqual({ error: "Tenant not found" });
    }
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });

  it("an author of ANOTHER tenant than the one in view cannot create one here", async () => {
    setSessionPrincipal([assign.tenant("ADMIN", "tenant-2")]);
    expect(await create()).toEqual({ error: "Tenant not found" });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });

  it("the entity ids a field refers to must be entities the caller can READ in the active tenant", async () => {
    setSessionPrincipal([assign.tenant("AUTHOR", "tenant-1")]);
    mockEntityFindUnique.mockResolvedValue(null);
    const field = { name: "customer", type: "reference", nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, decorators: { referencedEntityId: "ent-elsewhere" } };
    const answer = await createTenantEntityAction({ name: "Order", description: "", fields: [field] as never });
    expect(answer).toMatchObject({ error: expect.any(String) });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });
});
