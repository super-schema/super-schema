import { beforeEach, describe, expect, it, vi } from "vitest";

// The planner picks the entity's own model (named after the entity) and reads its fields' type names only from that model. A helper model
// declared ABOVE the entity must not change which names the entity's fields link to, or which type names it is refused for.

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { applyTypeSpecAction, compileAndApplyTypeSpecSourceAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const ORDER = { id: "ent-1", name: "Order", description: "", status: "DRAFT", version: 1, tenantId: "tenant-1", domainId: "dom-1", productId: null, domain: { id: "dom-1", name: "Sales", slug: "sales" }, product: null, metadata: {}, typespecSource: null, latestVersionId: null };
const CUSTOMER = { ...ORDER, id: "ent-cust", name: "Customer" };

const stored = (name: string, type = "string") => ({
  id: `fld-${name}`, entityId: "ent-1", name, slug: name, type, nullable: false, isKey: false, description: "", classification: null, decorators: {},
  sortOrder: 0, fieldNumber: 1, precision: null, scale: null,
});

const nothingWritten = () => {
  expect(mockPrisma.field.create).not.toHaveBeenCalled();
  expect(mockPrisma.field.update).not.toHaveBeenCalled();
  expect(mockPrisma.field.delete).not.toHaveBeenCalled();
  expect(mockPrisma.entity.update).not.toHaveBeenCalled();
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
};

/** The data of every field row the save created or updated. */
const writtenFieldData = () => [
  ...mockPrisma.field.create.mock.calls.map(([arg]) => arg.data),
  ...mockPrisma.field.update.mock.calls.map(([arg]) => arg.data),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.findUnique.mockResolvedValue(ORDER);
  mockPrisma.entity.findMany.mockImplementation(async ({ where }: { where: { tenantId: string } }) =>
    [ORDER, CUSTOMER].filter((e) => e.tenantId === where.tenantId),
  );
  mockPrisma.field.findMany.mockResolvedValue([]);
  mockPrisma.field.create.mockResolvedValue({ id: "fld-new" });
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.field.delete.mockResolvedValue({ id: "fld-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe("a helper model declared above the entity does not change the entity's type names", () => {
  it("the Source save links the entity's field to the tenant entity its own model names, though a helper model comes first", async () => {
    const result = await compileAndApplyTypeSpecSourceAction("ent-1", "model Helper { street: string; }\nmodel Order { customer: Customer; }\n");

    expect(result).toMatchObject({ success: true, applied: { added: 1, updated: 0, removed: [] } });
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({
      name: "customer",
      type: "reference",
      decorators: { referencedEntityId: "ent-cust" },
    });
  }, 60_000);

  it("the preview Apply links it the same way", async () => {
    const result = await applyTypeSpecAction("ent-1", "model Helper { street: string; }\nmodel Order { customer: Customer; }\n");

    expect(result).toEqual({ added: 1, updated: 0, removed: [] });
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({ name: "customer", type: "reference", decorators: { referencedEntityId: "ent-cust" } });
  }, 60_000);

  it("a helper model's field typed with a tenant entity does not turn the entity's string field into a reference", async () => {
    mockPrisma.field.findMany.mockResolvedValue([stored("customer", "string")]);

    const result = await compileAndApplyTypeSpecSourceAction("ent-1", "model Helper { customer: Customer; }\nmodel Order { customer: string; }\n");

    expect(result).toMatchObject({ success: true, applied: { added: 0, updated: 0, removed: [] } });
    expect(writtenFieldData().filter((data) => data.type === "reference")).toEqual([]);
    expect(mockPrisma.entity.update).toHaveBeenCalled();
  }, 60_000);

  it("a helper model's field typed with a model of the text is refused for the entity's field typed with that model's name, nothing is written", async () => {
    const result = await compileAndApplyTypeSpecSourceAction(
      "ent-1",
      "model Helper { buyer: Customer; }\nmodel Order { buyer: Address; }\nmodel Address { street: string; }\n",
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Field "buyer" is typed "Address", which is not a type of this app: use a TypeSpec standard type, an enum or union the source declares, or an entity of the tenant.',
    );
    nothingWritten();
  }, 60_000);

  it("a helper model's field named like the entity does not make the entity's own field a reference to the entity", async () => {
    const result = await compileAndApplyTypeSpecSourceAction("ent-1", "model Helper { owner: Order; }\nmodel Order { owner: string; }\n");

    expect(result).toMatchObject({ success: true, applied: { added: 1, updated: 0, removed: [] } });
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({ name: "owner", type: "string" });
    expect(writtenFieldData().filter((data) => data.type === "reference")).toEqual([]);
  }, 60_000);

  it("the control: with the entity's model first the same name links to the tenant entity", async () => {
    const result = await compileAndApplyTypeSpecSourceAction("ent-1", "model Order { customer: Customer; }\nmodel Helper { street: string; }\n");

    expect(result).toMatchObject({ success: true, applied: { added: 1, updated: 0, removed: [] } });
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({ name: "customer", type: "reference", decorators: { referencedEntityId: "ent-cust" } });
  }, 60_000);
});
