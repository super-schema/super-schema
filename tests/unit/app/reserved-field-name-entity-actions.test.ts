import { beforeEach, describe, expect, it, vi } from "vitest";

// A field named like a key the AsyncAPI parser cannot read (`hasOwnProperty`, `PARSER_UNSAFE_KEYS`) is refused wherever a person creates or
// renames an entity field through the entity actions: the add and the update of one field, and the TypeSpec source save (`applyTypeSpecAction`).

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
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
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: vi.fn() }));

import {
  addFieldAction,
  applyTypeSpecAction,
  updateFieldAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const MESSAGE = '"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another field name.';
const REFUSED = { error: MESSAGE, code: "VALIDATION_ERROR" };

const OWN_FIELD = { id: "fld-1", entityId: "ent-1", name: "email", slug: "email", type: "string", entity: { tenantId: "tenant-1" } };
const parsedField = (name: string) => ({ name, type: "string", isOptional: true, isKey: false, decorators: {} });

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", tenantId: "tenant-1", metadata: {} });
  mockPrisma.field.findUnique.mockResolvedValue(OWN_FIELD);
  mockPrisma.field.findFirst.mockResolvedValue(null);
  mockPrisma.field.findMany.mockResolvedValue([]);
  mockPrisma.field.create.mockResolvedValue({ id: "fld-2", entityId: "ent-1" });
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

const nothingWritten = () => {
  expect(mockPrisma.field.create).not.toHaveBeenCalled();
  expect(mockPrisma.field.update).not.toHaveBeenCalled();
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
};

describe("addFieldAction", () => {
  it.each(["hasOwnProperty", "  hasOwnProperty  ", "\thasOwnProperty"])("refuses the name %j with the reserved-name message, before any read or write", async (name) => {
    expect(await addFieldAction("ent-1", name, "string")).toEqual(REFUSED);
    expect(mockPrisma.entity.findUnique).not.toHaveBeenCalled();
    nothingWritten();
  });

  it.each(["hasownproperty", "HasOwnProperty", "hasOwnProperty2", "hasOwnProperty_1", "valueOf"])("accepts %j", async (name) => {
    expect(await addFieldAction("ent-1", name, "string")).toMatchObject({ success: true });
    expect(mockPrisma.field.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name }) }));
  });

  it("stores a padded ordinary name trimmed, as before", async () => {
    await addFieldAction("ent-1", " phone ", "string");
    expect(mockPrisma.field.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: "phone" }) }));
  });
});

describe("updateFieldAction (rename)", () => {
  it.each(["hasOwnProperty", "  hasOwnProperty "])("refuses renaming a field to %j, and writes nothing", async (name) => {
    expect(await updateFieldAction("fld-1", { name })).toEqual(REFUSED);
    nothingWritten();
  });

  it.each(["hasownproperty", "HasOwnProperty", "hasOwnProperty2"])("accepts a rename to %j", async (name) => {
    expect(await updateFieldAction("fld-1", { name })).toEqual({ success: true });
    expect(mockPrisma.field.update).toHaveBeenCalledTimes(1);
  });

  it("an update that does not touch the name is not refused (the field studio sends the name along with every other edit)", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ ...OWN_FIELD, name: "hasOwnProperty", slug: "hasownproperty" });
    expect(await updateFieldAction("fld-1", { name: "hasOwnProperty", description: "legacy field, other edits stay possible" })).toEqual({ success: true });
    expect(await updateFieldAction("fld-1", { description: "x" })).toEqual({ success: true });
  });
});

describe("applyTypeSpecAction (the TypeSpec source save projects the model's fields onto field rows)", () => {
  it("refuses a model with a NEW field named hasOwnProperty, before it writes anything", async () => {
    const result = await applyTypeSpecAction("ent-1", [parsedField("id"), parsedField("hasOwnProperty")]);
    expect(result).toEqual({ added: 0, updated: 0, removed: [], error: MESSAGE });
    nothingWritten();
  });

  it("looks at the trimmed name, and at the new fields only: a field that already exists is left alone", async () => {
    expect(await applyTypeSpecAction("ent-1", [parsedField(" hasOwnProperty ")])).toMatchObject({ error: MESSAGE });
    nothingWritten();
    mockPrisma.field.findMany.mockResolvedValue([{ id: "fld-9", entityId: "ent-1", name: "hasOwnProperty", sortOrder: 0, fieldNumber: 1, type: "string", nullable: true, isKey: false, description: "", classification: null, decorators: {} }]);
    expect(await applyTypeSpecAction("ent-1", [parsedField("hasOwnProperty"), parsedField("id")])).toEqual({ added: 1, updated: 0, removed: [] });
    expect(mockPrisma.field.create).toHaveBeenCalledTimes(1);
  });

  it("accepts the look-alikes", async () => {
    expect(await applyTypeSpecAction("ent-1", [parsedField("hasownproperty"), parsedField("HasOwnProperty"), parsedField("hasOwnProperty2")])).toEqual({ added: 3, updated: 0, removed: [] });
  });
});
