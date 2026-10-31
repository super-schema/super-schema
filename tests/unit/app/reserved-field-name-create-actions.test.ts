import { beforeEach, describe, expect, it, vi } from "vitest";

// The entity wizard (`createEntityWithFieldsAction` for a product entity, `createTenantEntityAction` for an Enterprise one) takes the
// fields a person typed or reviewed: a field named like a key the AsyncAPI parser cannot read (`PARSER_UNSAFE_KEYS`) is refused, by
// name, before anything is created.

const { mockAuth, mockPrisma, mockTx, mockAssertNameAvailable, mockEnsureDefaultProductId } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    tenant: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    product: { findUnique: vi.fn(), create: vi.fn() },
    domain: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockTx: { field: { findMany: vi.fn(async () => []) }, entity: { create: vi.fn(), findFirst: vi.fn() } },
  mockAssertNameAvailable: vi.fn(),
  mockEnsureDefaultProductId: vi.fn(),
}));

vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/lib/org-defaults", () => ({ ensureDefaultProductId: mockEnsureDefaultProductId }));
vi.mock("@/services/name-registry.service", () => ({
  assertNameAvailable: mockAssertNameAvailable,
  withTenantNameLock: (_db: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
}));

import { createEntityWithFieldsAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { createTenantEntityAction } from "@/app/(dashboard)/schemas/enterprise/actions";

const MESSAGE = '"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another field name.';
const field = (name: string) => ({ name, type: "string", nullable: false, isKey: false, description: "", classification: null, precision: null, scale: null });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", email: "owner@example.com" } });
  mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.domain.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  mockPrisma.product.findUnique.mockResolvedValue({ id: "prd-default", domainId: "domain-1", domain: { tenantId: "tenant-1" } });
  mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
  mockTx.entity.findFirst.mockResolvedValue(null);
  mockTx.entity.create.mockResolvedValue({ id: "entity-1", slug: "customer" });
  mockEnsureDefaultProductId.mockResolvedValue("prd-default");
});

describe("createEntityWithFieldsAction", () => {
  it.each(["hasOwnProperty", "  hasOwnProperty "])("refuses a field named %j and creates nothing", async (name) => {
    const result = await createEntityWithFieldsAction("domain-1", { name: "Customer", description: "", fields: [field("id"), field(name)] });
    expect(result).toEqual({ error: MESSAGE, code: "VALIDATION_ERROR" });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("creates the entity when no field is reserved, look-alikes included", async () => {
    const result = await createEntityWithFieldsAction("domain-1", {
      name: "Customer", description: "", fields: [field("id"), field("hasownproperty"), field("HasOwnProperty"), field("hasOwnProperty2")],
    });
    expect(result).toEqual({ success: true, entityId: "entity-1" });
    expect(mockTx.entity.create).toHaveBeenCalledTimes(1);
  });
});

describe("createTenantEntityAction", () => {
  it.each(["hasOwnProperty", "  hasOwnProperty "])("refuses a field named %j and creates nothing", async (name) => {
    const result = await createTenantEntityAction({ name: "Customer", description: "", fields: [field("id"), field(name)] });
    expect(result).toEqual({ error: MESSAGE });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("creates the entity when no field is reserved, look-alikes included", async () => {
    const result = await createTenantEntityAction({ name: "Customer", description: "", fields: [field("id"), field("hasownproperty"), field("HasOwnProperty")] });
    expect(result).toEqual({ success: true, entity: { id: "entity-1", slug: "customer" } });
  });

  it("a malformed field list is not this check's business (it never throws on one)", async () => {
    const result = await createTenantEntityAction({ name: "Customer", description: "", fields: [{ nope: true }] as never });
    expect(result).not.toEqual({ error: MESSAGE });
  });
});
