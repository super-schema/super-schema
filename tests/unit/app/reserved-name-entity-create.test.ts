import { beforeEach, describe, expect, it, vi } from "vitest";
import { PARSER_UNSAFE_KEYS } from "@/lib/event-specs/own-property";

// The entity creation actions (the wizard with fields, the plain form, the Enterprise wizard) create through `createInScope`, whose name
// registry is REAL here: an entity named like a parser-unsafe key (`PARSER_UNSAFE_KEYS`) is refused with the registry's one message.

const { mockAuth, mockPrisma, mockTx } = await vi.hoisted(async () => {
  const { emptyRegistryDelegates } = await import("../../helpers/registry-mocks");
  const registry = emptyRegistryDelegates();
  return {
    mockAuth: vi.fn(),
    mockPrisma: {
      tenant: { findUnique: vi.fn() },
      user: { findUnique: vi.fn() },
      product: { findUnique: vi.fn(), create: vi.fn() },
      domain: { findUnique: vi.fn() },
      auditLog: { create: vi.fn() },
    },
    mockTx: { ...registry, entity: { ...registry.entity, create: vi.fn(), findFirst: vi.fn() } },
  };
});

vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/lib/org-defaults", () => ({ ensureDefaultProductId: vi.fn().mockResolvedValue("prd-default") }));
vi.mock("@/services/name-registry.service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/name-registry.service")>();
  return { ...original, withTenantNameLock: (_db: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx) };
});

import { createEntityAction, createEntityWithFieldsAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { createTenantEntityAction } from "@/app/(dashboard)/schemas/enterprise/actions";

const [UNSAFE] = [...PARSER_UNSAFE_KEYS];
const MESSAGE = `"${UNSAFE}" is a reserved name: AsyncAPI documents cannot contain it. Choose another name.`;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", email: "owner@example.com" } });
  mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.domain.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  mockPrisma.product.findUnique.mockResolvedValue({ id: "prd-default", domainId: "domain-1", domain: { tenantId: "tenant-1" } });
  mockTx.entity.findFirst.mockResolvedValue(null);
  mockTx.entity.create.mockResolvedValue({ id: "entity-1", slug: "x" });
});

describe("an entity named like a parser-unsafe key", () => {
  it("createEntityWithFieldsAction refuses it (trimmed too) with the registry's message, and creates nothing", async () => {
    for (const name of [UNSAFE, `  ${UNSAFE} `]) {
      expect(await createEntityWithFieldsAction("domain-1", { name, description: "", fields: [] }), name).toEqual({ error: MESSAGE });
    }
    expect(mockTx.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("createEntityAction (the plain form) refuses it", async () => {
    const form = new FormData();
    form.set("name", UNSAFE);
    expect(await createEntityAction("domain-1", form)).toEqual({ error: MESSAGE });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });

  it("createTenantEntityAction (the Enterprise wizard) refuses it", async () => {
    expect(await createTenantEntityAction({ name: UNSAFE, description: "", fields: [] })).toEqual({ error: MESSAGE });
    expect(mockTx.entity.create).not.toHaveBeenCalled();
  });

  it("the look-alikes are created", async () => {
    expect(await createEntityWithFieldsAction("domain-1", { name: UNSAFE.toLowerCase(), description: "", fields: [] })).toEqual({ success: true, entityId: "entity-1" });
    expect(await createTenantEntityAction({ name: `${UNSAFE}2`, description: "", fields: [] })).toMatchObject({ success: true });
  });
});
