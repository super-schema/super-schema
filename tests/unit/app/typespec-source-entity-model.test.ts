import { beforeEach, describe, expect, it, vi } from "vitest";

// The Source tab save writes the rows of the entity's OWN model: the model named after the entity, never the first model of the text. A text
// that declares no model of the entity's name is refused, and nothing is removed because of it (the fields of the entity are not the fields of
// some other model the text happens to declare).

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

const entityNamed = (name: string) => ({ id: "ent-1", name, tenantId: "tenant-1", domainId: null, productId: null, metadata: {}, typespecSource: null });

const stored = (name: string, id = `fld-${name}`) => ({
  id, entityId: "ent-1", name, slug: name, type: "string", nullable: false, isKey: false, description: "", classification: null, decorators: {},
  sortOrder: 0, fieldNumber: 1, precision: null, scale: null,
});

const nothingWritten = () => {
  expect(mockPrisma.field.create).not.toHaveBeenCalled();
  expect(mockPrisma.field.update).not.toHaveBeenCalled();
  expect(mockPrisma.field.delete).not.toHaveBeenCalled();
  expect(mockPrisma.entity.update).not.toHaveBeenCalled();
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.findUnique.mockResolvedValue(entityNamed("Customer"));
  mockPrisma.entity.findMany.mockResolvedValue([]);
  mockPrisma.field.findMany.mockResolvedValue([stored("id"), stored("email"), stored("name")]);
  mockPrisma.field.create.mockResolvedValue({ id: "fld-new" });
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.field.delete.mockResolvedValue({ id: "fld-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe("the Source save writes the entity's own model, not the first model of the text", () => {
  it("a helper model declared above the entity adds nothing and removes nothing: the entity's model is the one written", async () => {
    const source = "model Address { street: string; }\nmodel Customer { id: string; email: string; name: string; }\n";

    const result = await compileAndApplyTypeSpecSourceAction("ent-1", source);

    expect(result).toMatchObject({ success: true, applied: { added: 0, updated: 0, removed: [] } });
    expect(mockPrisma.field.create.mock.calls.map(([arg]) => arg.data.name)).not.toContain("street");
    expect(mockPrisma.field.delete).not.toHaveBeenCalled();
    // The text itself is saved: the source is canonical, with both models.
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({ where: { id: "ent-1" }, data: { typespecSource: source, hasUnpublishedChanges: true } });
  }, 60_000);

  it("a text whose models are not the entity's own is refused: no field is created, updated or removed, and the source is not saved", async () => {
    const result = await compileAndApplyTypeSpecSourceAction("ent-1", "model Address { street: string; }\nmodel Buyer { id: string; }\n");

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'The source declares no model for this entity: its model is named "Customer" (the entity\'s name as an identifier), and the source declares "Address", "Buyer". Declare "Customer", or rename the entity, then save again.',
    );
    nothingWritten();
  }, 60_000);

  it("a text with a single model named otherwise than the entity is refused when saving it would remove stored fields: nothing is removed on a guess", async () => {
    const result = await compileAndApplyTypeSpecSourceAction("ent-1", "model Address { street: string; }\n");

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'The source declares one model, "Address", which is not the entity\'s model ("Customer"), and saving it would remove 3 stored fields the source does not name ("id", "email", "name"). Name the model "Customer", or rename the entity, then save again.',
    );
    nothingWritten();
  }, 60_000);

  it("a text with a single model named otherwise than the entity is taken as its own when it removes nothing (its fields are added or updated)", async () => {
    mockPrisma.field.findMany.mockResolvedValue([stored("id"), stored("email")]);

    const result = await compileAndApplyTypeSpecSourceAction("ent-1", "model Address { id: string; email: string; street: string; }\n");

    expect(result).toMatchObject({ success: true, applied: { added: 1, updated: 0, removed: [] } });
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({ name: "street" });
    expect(mockPrisma.field.delete).not.toHaveBeenCalled();
  }, 60_000);

  it("an entity whose name is not an identifier has the model named as the identifier (`Order Item` is `Order_Item`)", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue(entityNamed("Order Item"));
    mockPrisma.field.findMany.mockResolvedValue([]);

    const result = await compileAndApplyTypeSpecSourceAction("ent-1", "model Helper { x: string; }\nmodel Order_Item { id: string; }\n");

    expect(result).toMatchObject({ success: true, applied: { added: 1, updated: 0, removed: [] } });
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({ name: "id" });
  }, 60_000);
});

describe("the preview's Apply removes only the fields the person confirmed, so it is refused only for a confirmed removal", () => {
  it("a single model named otherwise, with no confirmed removal, is applied: its fields are added and nothing is removed", async () => {
    const result = await applyTypeSpecAction("ent-1", "model Address { street: string; }\n", []);

    expect(result).toMatchObject({ added: 1, updated: 0, removed: [] });
    expect(result.error).toBeUndefined();
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({ name: "street" });
    expect(mockPrisma.field.delete).not.toHaveBeenCalled();
  }, 60_000);

  it("the same model is refused when a removal the person confirmed would go: nothing is written", async () => {
    const result = await applyTypeSpecAction("ent-1", "model Address { street: string; }\n", ["email"]);

    expect(result.error).toBe(
      'The source declares one model, "Address", which is not the entity\'s model ("Customer"), and applying it would remove 1 stored field the source does not name ("email"). Name the model "Customer", or rename the entity, then apply again.',
    );
    nothingWritten();
  }, 60_000);
});
