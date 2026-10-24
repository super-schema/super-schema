/**
 * Multi-entity emission, Task 11: the TypeSpec Source tab save resolves the models a field names against the TENANT's entities.
 *
 * The real action (`compileAndApplyTypeSpecSourceAction`) runs with the REAL compiler; Prisma, auth and Next are mocked. Before this task
 * an entity whose source referenced another entity's model could not be saved at all: the single-entity compile fails with `invalid-ref`
 * (the model is declared nowhere in that source), and the text the tab itself shows for such an entity (`address: Address;`) is exactly that.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { compileAndApplyTypeSpecSourceAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";

type Tenant = { id: string; name: string; domain?: string; product?: string };

/** The rows `loadTenantIndex` reads: the whole tenant, the entity being saved included. */
const indexRow = (e: Tenant) => ({
  id: e.id,
  name: e.name,
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: e.domain ? `dom-${e.domain}` : null,
  latestVersionId: null,
  domain: e.domain ? { id: `dom-${e.domain}`, name: e.domain, slug: e.domain.toLowerCase() } : null,
  product: e.product ? { name: e.product } : null,
});

const SELF: Tenant = { id: "ent-1", name: "Customer", domain: "Sales", product: "Orders" };
const ADDRESS_BILLING: Tenant = { id: "addr-1", name: "Address", domain: "Billing", product: "Payments" };
const ADDRESS_SALES: Tenant = { id: "addr-2", name: "Address", domain: "Sales", product: "Shipping" };

function tenant(...others: Tenant[]) {
  mockPrisma.entity.findMany.mockResolvedValue([SELF, ...others].map(indexRow));
}

type StoredField = { id: string; name: string; type: string; nullable?: boolean; isKey?: boolean; decorators?: Record<string, unknown> };
function stored(...rows: StoredField[]) {
  mockPrisma.field.findMany.mockResolvedValue(
    rows.map((r, i) => ({
      id: r.id, entityId: "ent-1", name: r.name, slug: r.name, type: r.type, sortOrder: i, fieldNumber: i + 1,
      nullable: r.nullable ?? false, isKey: r.isKey ?? false, description: "", classification: null, decorators: r.decorators ?? {},
    })),
  );
}

const save = (source: string, picks?: Record<string, string>) =>
  (compileAndApplyTypeSpecSourceAction as unknown as (id: string, s: string, p?: Record<string, string>) => ReturnType<typeof compileAndApplyTypeSpecSourceAction>)(
    "ent-1", source, picks,
  );

const created = (name: string) => {
  const call = mockPrisma.field.create.mock.calls.map(([arg]) => (arg as { data: Record<string, unknown> }).data).find((d) => d.name === name);
  return call as { name: string; type: string; decorators: Record<string, unknown> } | undefined;
};
const updated = (id: string) => {
  const call = mockPrisma.field.update.mock.calls.map(([arg]) => arg as { where: { id: string }; data: Record<string, unknown> }).find((a) => a.where.id === id);
  return call?.data as { type: string; decorators: Record<string, unknown> } | undefined;
};
const nothingWritten = () => {
  expect(mockPrisma.field.create).not.toHaveBeenCalled();
  expect(mockPrisma.field.update).not.toHaveBeenCalled();
  expect(mockPrisma.field.delete).not.toHaveBeenCalled();
  expect(mockPrisma.entity.update).not.toHaveBeenCalled();
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
};

const model = (...fields: string[]) => `model Customer {\n  @key id: string;\n${fields.map((f) => `  ${f}\n`).join("")}}\n`;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null, tenantId: "tenant-1", metadata: null });
  mockPrisma.field.create.mockResolvedValue({ id: "new" });
  mockPrisma.field.update.mockResolvedValue({ id: "upd" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  stored();
  tenant();
});

describe("an entity whose source references another entity's model can be saved (the earlier defect)", () => {
  it("a field typed with the bare name of ONE tenant entity: the save succeeds and the field is stored as a qualified reference", async () => {
    tenant(ADDRESS_BILLING);
    const source = model("address: Address;");

    const res = await save(source);

    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // A lint on the empty stand-in is about the stand-in, never shown as if it were about the user's source.
    expect(res.diagnostics.filter((d) => /Address/.test(d.message))).toEqual([]);
    expect(res).toMatchObject({ success: true, applied: { added: 2 } });
    const field = created("address");
    expect(field?.type).toBe("reference");
    expect(field?.decorators).toMatchObject({
      referencedEntityId: "addr-1",
      referencedEntityName: "Address",
      referencedQualifiedName: "Billing/Payments/Address",
    });
    // A reference carries NO version unless one is pinned.
    expect(field?.decorators).not.toHaveProperty("referencedEntityVersion");
    // The source stays the user's text: no stub model, no qualified spelling written into it.
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({ where: { id: "ent-1" }, data: { typespecSource: source, hasUnpublishedChanges: true } });
  });

  it("the stored source never holds, and no row is ever made of, the stand-in the validation compile used", async () => {
    tenant(ADDRESS_BILLING);

    await save(model("address: Address;"));

    expect(mockPrisma.field.create.mock.calls.map(([a]) => (a as { data: { name: string } }).data.name).sort()).toEqual(["address", "id"]);
    const written = (mockPrisma.entity.update.mock.calls[0][0] as { data: { typespecSource: string } }).data.typespecSource;
    expect(written).not.toMatch(/model\s+Address/);
  });

  it("an array of the entity: an array of references, the element target on the field", async () => {
    tenant(ADDRESS_BILLING);

    const res = await save(model("addresses: Address[];"));

    expect(res.success).toBe(true);
    const field = created("addresses");
    expect(field?.type).toBe("array");
    expect(field?.decorators).toMatchObject({ arrayElementType: "reference", referencedEntityId: "addr-1", referencedQualifiedName: "Billing/Payments/Address" });
  });

  it("a name no tenant entity has is still an error, exactly as before (nothing is guessed, nothing is written)", async () => {
    tenant(ADDRESS_BILLING);

    const res = await save(model("address: Nowhere;"));

    expect(res.success).toBe(false);
    expect(res.diagnostics).toEqual([expect.objectContaining({ severity: "error", code: "invalid-ref", message: "Unknown identifier Nowhere" })]);
    nothingWritten();
  });

  it("a name the tenant has in a position that is not the type of a field (extends, a spread, a map value, a union) is still an error", async () => {
    tenant(ADDRESS_BILLING);
    for (const text of [
      "model Customer extends Address {\n  @key id: string;\n}\n",
      "model Customer {\n  @key id: string;\n  ...Address;\n}\n",
      model("byKey: Record<Address>;"),
      model("maybe: Address | string;"),
      // the same name ALSO as a field type does not make the other use acceptable
      "model Customer {\n  @key id: string;\n  ...Address;\n  home: Address;\n}\n",
    ]) {
      const res = await save(text);
      expect(res, text).toMatchObject({ success: false });
      expect(res.diagnostics.map((d) => d.code), text).toContain("invalid-ref");
    }
    nothingWritten();
  });
});

describe("a name written as Domain.Product.Entity resolves by its qualified name", () => {
  it("picks the one entity that qualified name means even when the bare name is ambiguous in the tenant", async () => {
    tenant(ADDRESS_BILLING, ADDRESS_SALES);

    const res = await save(model("address: Billing.Payments.Address;"));

    expect(res.success).toBe(true);
    expect(created("address")?.decorators).toMatchObject({
      referencedEntityId: "addr-1",
      referencedEntityName: "Address",
      referencedQualifiedName: "Billing/Payments/Address",
    });
    expect(created("address")?.type).toBe("reference");
  });

  it("works for an array, and for the _tenant placeholder of an entity with no domain / product", async () => {
    tenant(ADDRESS_SALES, { id: "loose-1", name: "Note" });

    const res = await save(model("shipping: Sales.Shipping.Address[];", "note: _tenant._tenant.Note;"));

    expect(res.success).toBe(true);
    expect(created("shipping")?.decorators).toMatchObject({ arrayElementType: "reference", referencedEntityId: "addr-2" });
    expect(created("note")?.decorators).toMatchObject({ referencedEntityId: "loose-1", referencedQualifiedName: "_tenant/_tenant/Note" });
  });

  it("a qualified name no entity has is an error (nothing resolves, nothing is guessed)", async () => {
    tenant(ADDRESS_BILLING);

    const res = await save(model("address: Billing.Elsewhere.Address;"));

    expect(res.success).toBe(false);
    expect(res.diagnostics.map((d) => d.code)).toContain("invalid-ref");
    nothingWritten();
  });
});

describe("a bare name that matches several tenant entities is not guessed", () => {
  const needs = {
    field: "address",
    name: "Address",
    entityId: "ent-1",
    candidates: [
      expect.objectContaining({ entityId: "addr-1", domain: "Billing", product: "Payments", entity: "Address" }),
      expect.objectContaining({ entityId: "addr-2", domain: "Sales", product: "Shipping", entity: "Address" }),
    ],
  };

  it("a NEW field: the save asks (needsReference with the candidates), writes nothing and leaves the stored source alone", async () => {
    tenant(ADDRESS_BILLING, ADDRESS_SALES);

    const res = (await save(model("address: Address;"))) as { success: boolean; needsReference?: unknown; error?: string };

    expect(res.success).toBe(false);
    expect(res.needsReference).toMatchObject({ ...needs, fieldId: "" });
    expect(res.error).toMatch(/Address/);
    nothingWritten();
  });

  it("a stored legacy reference: needsReference names the row that holds it", async () => {
    tenant(ADDRESS_BILLING, ADDRESS_SALES);
    stored(
      { id: "f-id", name: "id", type: "string", isKey: true },
      { id: "f-address", name: "address", type: "reference", decorators: { referencedEntityName: "Address" } },
    );

    const res = (await save(model("address: Address;"))) as { success: boolean; needsReference?: unknown };

    expect(res.success).toBe(false);
    expect(res.needsReference).toMatchObject({ ...needs, fieldId: "f-address" });
    nothingWritten();
  });

  it("the pick comes back with the retry: the field is stored as the qualified reference of the entity picked, and only then is anything written", async () => {
    tenant(ADDRESS_BILLING, ADDRESS_SALES);

    const res = await save(model("address: Address;"), { address: "addr-2" });

    expect(res.success).toBe(true);
    expect(created("address")?.decorators).toMatchObject({
      referencedEntityId: "addr-2",
      referencedQualifiedName: "Sales/Shipping/Address",
    });
    expect(created("address")?.decorators).not.toHaveProperty("referencedEntityVersion");
  });

  it("a pick that is none of the candidates (another tenant's id, a made-up id) is ignored: the save asks again and writes nothing", async () => {
    tenant(ADDRESS_BILLING, ADDRESS_SALES);

    for (const bogus of ["foreign-tenant-entity", "ent-1", ""]) {
      const res = (await save(model("address: Address;"), { address: bogus })) as { needsReference?: unknown };
      expect(res.needsReference, bogus).toMatchObject(needs);
    }
    nothingWritten();
  });

  it("two ambiguous fields are asked one at a time, in field order; each pick is kept for the retry", async () => {
    tenant(ADDRESS_BILLING, ADDRESS_SALES);
    const source = model("billing: Address;", "shipping: Address;");

    const first = (await save(source)) as { needsReference?: { field: string } };
    expect(first.needsReference?.field).toBe("billing");
    const second = (await save(source, { billing: "addr-1" })) as { needsReference?: { field: string } };
    expect(second.needsReference?.field).toBe("shipping");
    const done = await save(source, { billing: "addr-1", shipping: "addr-2" });

    expect(done.success).toBe(true);
    expect(created("billing")?.decorators).toMatchObject({ referencedEntityId: "addr-1" });
    expect(created("shipping")?.decorators).toMatchObject({ referencedEntityId: "addr-2" });
  });

  it("the resolver reads only THIS tenant's entities", async () => {
    tenant(ADDRESS_BILLING);

    await save(model("address: Address;"));

    expect(mockPrisma.entity.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.entity.findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: "tenant-1" } });
  });
});

describe("a reference the entity already stores", () => {
  it("a legacy name-only reference that resolves to one entity is upgraded to the qualified form (id and qualified name; no version)", async () => {
    tenant(ADDRESS_BILLING);
    stored(
      { id: "f-id", name: "id", type: "string", isKey: true },
      { id: "f-address", name: "address", type: "reference", decorators: { referencedEntityName: "Address" } },
    );

    const res = await save(model("address: Address;"));

    expect(res.success).toBe(true);
    expect(updated("f-address")?.type).toBe("reference");
    expect(updated("f-address")?.decorators).toMatchObject({
      referencedEntityId: "addr-1",
      referencedEntityName: "Address",
      referencedQualifiedName: "Billing/Payments/Address",
    });
    expect(updated("f-address")?.decorators).not.toHaveProperty("referencedEntityVersion");
  });

  it("a qualified reference is unchanged by a save, even though the bare name now matches several entities: the id says which one", async () => {
    tenant(ADDRESS_BILLING, ADDRESS_SALES);
    const decorators = { referencedEntityId: "addr-2", referencedEntityName: "Address", referencedQualifiedName: "Sales/Shipping/Address" };
    stored(
      { id: "f-id", name: "id", type: "string", isKey: true },
      { id: "f-address", name: "address", type: "reference", decorators },
    );

    const res = await save(model("address: Address;"));

    expect(res).toMatchObject({ success: true, applied: { added: 0, updated: 0, removed: [] } });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
    expect(mockPrisma.field.create).not.toHaveBeenCalled();
  });

  it("the entity was renamed after the text was written: the stale name (bare or Domain.Product.Entity) still saves, the id keeps the reference", async () => {
    tenant({ id: "addr-1", name: "Location", domain: "Billing", product: "Payments" });
    const decorators = { referencedEntityId: "addr-1", referencedEntityName: "Address", referencedQualifiedName: "Billing/Payments/Address" };

    for (const written of ["Address", "Billing.Payments.Address"]) {
      vi.clearAllMocks();
      mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
      mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null, tenantId: "tenant-1", metadata: null });
      mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
      mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
      tenant({ id: "addr-1", name: "Location", domain: "Billing", product: "Payments" });
      stored({ id: "f-id", name: "id", type: "string", isKey: true }, { id: "f-address", name: "address", type: "reference", decorators });

      const res = await save(model(`address: ${written};`));

      expect(res, written).toMatchObject({ success: true, applied: { added: 0, updated: 0 } });
      expect(mockPrisma.field.update, written).not.toHaveBeenCalled();
    }
  });

  it("a stored reference to an entity that no longer exists stays as it is and the save goes through (the entity is not stuck)", async () => {
    tenant();
    stored(
      { id: "f-id", name: "id", type: "string", isKey: true },
      { id: "f-address", name: "address", type: "reference", decorators: { referencedEntityName: "Address" } },
    );

    const res = await save(model("address: Address;", "note?: string;"));

    expect(res.success).toBe(true);
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
    expect(created("note")).toBeDefined();
  });

  it("the name of a deleted entity kept on one field does not make that name acceptable on another, new field", async () => {
    tenant();
    stored(
      { id: "f-id", name: "id", type: "string", isKey: true },
      { id: "f-address", name: "address", type: "reference", decorators: { referencedEntityName: "Address" } },
    );

    const res = await save(model("address: Address;", "other: Address;"));

    expect(res.success).toBe(false);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([
      expect.objectContaining({ code: "invalid-ref", message: "Unknown identifier Address" }),
    ]);
    nothingWritten();
  });

  it("the reference pin tag still means a pin: stored with the reference, and only then", async () => {
    tenant(ADDRESS_BILLING);
    const pinned = `import "@typespec/openapi";\n\nmodel Customer {\n  @key id: string;\n  @TypeSpec.OpenAPI.extension("x-super-schema-pin", "1.2")\n  address: Address;\n}\n`;

    const res = await save(pinned);

    expect(res.success).toBe(true);
    expect(created("address")?.decorators).toMatchObject({ referencedEntityId: "addr-1", referencedEntityVersion: "1.2" });
  });

  it("retargeting a reference by writing another name replaces its id, name, qualified name and pin", async () => {
    tenant(ADDRESS_BILLING, { id: "note-1", name: "Note", domain: "Sales", product: "Orders" });
    stored(
      { id: "f-id", name: "id", type: "string", isKey: true },
      {
        id: "f-ref", name: "address", type: "reference",
        decorators: { referencedEntityId: "addr-1", referencedEntityName: "Address", referencedQualifiedName: "Billing/Payments/Address", referencedEntityVersion: "1.0" },
      },
    );

    const res = await save(model("address: Note;"));

    expect(res.success).toBe(true);
    const decorators = updated("f-ref")?.decorators;
    expect(decorators).toMatchObject({ referencedEntityId: "note-1", referencedEntityName: "Note", referencedQualifiedName: "Sales/Orders/Note" });
    expect(decorators).not.toHaveProperty("referencedEntityVersion");
  });
});

describe("the text the tab itself shows for an entity that references another entity can be saved (the earlier defect, end to end)", () => {
  const entity = { id: "ent-1", name: "Customer", description: "", status: "DRAFT", version: 1, domainId: "dom-Sales", metadata: null, domain: { id: "dom-Sales", name: "Sales", slug: "sales" } };
  const input = (id: string, name: string, type: string, decorators: Record<string, unknown>, sortOrder: number): PrismaFieldInput => ({
    id, name, type, precision: null, scale: null, nullable: false, isKey: sortOrder === 0, fieldNumber: null, description: "", classification: null,
    aliases: [], decorators, sortOrder,
  });
  /** The source `getTypeSpecSourceAction` generates for these rows, and the same rows as the database holds them. */
  const shown = (rows: PrismaFieldInput[]) => {
    stored(...rows.map((r) => ({ id: r.id, name: r.name, type: r.type, isKey: r.isKey, decorators: r.decorators as Record<string, unknown> })));
    return generateTypeSpec(compileEntity(entity, rows));
  };

  it("a legacy name-only reference: the text names the entity, the save succeeds and upgrades the field to the qualified reference", async () => {
    tenant(ADDRESS_BILLING);
    const text = shown([input("f-id", "id", "string", {}, 0), input("f-address", "address", "reference", { referencedEntityName: "Address" }, 1)]);
    expect(text).toContain("address: Address;");

    const res = await save(text);

    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res.success).toBe(true);
    expect(updated("f-address")?.decorators).toMatchObject({ referencedEntityId: "addr-1", referencedQualifiedName: "Billing/Payments/Address" });
  });

  it("a qualified reference to one of two entities of that name: saving the shown text changes nothing and asks nothing", async () => {
    tenant(ADDRESS_BILLING, ADDRESS_SALES);
    const decorators = { referencedEntityId: "addr-2", referencedEntityName: "Address", referencedQualifiedName: "Sales/Shipping/Address" };
    const text = shown([input("f-id", "id", "string", {}, 0), input("f-address", "address", "reference", decorators, 1)]);

    const res = await save(text);

    expect(res).toMatchObject({ success: true, applied: { added: 0, updated: 0, removed: [] } });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it("an array of references, and a self-reference, in the shown text", async () => {
    tenant(ADDRESS_BILLING);
    const text = shown([
      input("f-id", "id", "string", {}, 0),
      input("f-homes", "homes", "array", { arrayElementType: "reference", referencedEntityName: "Address" }, 1),
      input("f-parent", "parent", "reference", { referencedEntityName: "Customer" }, 2),
    ]);

    const res = await save(text);

    expect(res.success).toBe(true);
    expect(updated("f-homes")?.decorators).toMatchObject({ arrayElementType: "reference", referencedEntityId: "addr-1" });
    expect(updated("f-parent")?.decorators).toMatchObject({ referencedEntityId: "ent-1", referencedQualifiedName: "Sales/Orders/Customer" });
  });
});

describe("a self-reference", () => {
  it("saves, and is stored as a reference to this very entity", async () => {
    tenant();

    const res = await save(model("parent?: Customer;", "children: Customer[];"));

    expect(res.success).toBe(true);
    expect(created("parent")?.type).toBe("reference");
    expect(created("parent")?.decorators).toMatchObject({ referencedEntityId: "ent-1", referencedQualifiedName: "Sales/Orders/Customer" });
    expect(created("children")?.decorators).toMatchObject({ arrayElementType: "reference", referencedEntityId: "ent-1" });
  });

  it("is never ambiguous: the model of the source IS this entity, whatever else the tenant names Customer", async () => {
    tenant({ id: "cust-2", name: "Customer", domain: "Marketing", product: "Leads" });

    const res = await save(model("parent?: Customer;"));

    expect(res.success).toBe(true);
    expect(created("parent")?.decorators).toMatchObject({ referencedEntityId: "ent-1" });
  });
});

describe("a model the source declares itself keeps meaning that model", () => {
  it("a field typed with a model declared in the same source is not resolved against the tenant, even when an entity has that name", async () => {
    tenant(ADDRESS_BILLING);
    const source = `${model("address: Address;")}\nmodel Address {\n  street: string;\n}\n`;

    const res = await save(source);

    expect(res.success).toBe(true);
    expect(created("address")?.type).toBe("Address");
    expect(created("address")?.decorators).not.toHaveProperty("referencedEntityId");
    expect(mockPrisma.entity.findMany).not.toHaveBeenCalled();
  });
});

describe("a model named like a TypeSpec built-in type is refused, not silently mistyped", () => {
  // The compiler itself fails loudly (`ambiguous-symbol`) when the document USES the built-in a global declaration shares its name with.
  // The cases below are the ones that compile: the name is declared and the built-in is not used, so nothing else would object.
  it.each(["string", "int32", "utcDateTime", "boolean", "bytes", "decimal128"])("model %s", async (name) => {
    const res = await save(`model ${name} {\n  @key id: int64;\n}\n`);

    expect(res.success).toBe(false);
    expect(res.error).toBe(
      `Model "${name}" is named like a TypeSpec built-in type: a field typed "${name}" would mean this model instead of the built-in. Choose another name.`,
    );
    nothingWritten();
  });

  it("a model named string that the document also types a field with is the compiler's own ambiguity error, and nothing is written either", async () => {
    const res = await save("model string {\n  @key id: string;\n}\n");

    expect(res.success).toBe(false);
    expect(res.diagnostics.map((d) => d.code)).toContain("ambiguous-symbol");
    nothingWritten();
  });

  it("Record and Array are used by the compiler itself: the compile fails loudly before any name check is needed", async () => {
    for (const name of ["Record", "Array"]) {
      const res = await save(`model ${name} {\n  @key id: int64;\n}\n`);
      expect(res.success, name).toBe(false);
      expect(res.diagnostics.some((d) => d.severity === "error"), name).toBe(true);
    }
    nothingWritten();
  });

  it("also a second model, an enum, a scalar or a union with such a name", async () => {
    const entity = "model Customer {\n  @key id: int64;\n}\n";
    for (const [kind, name, declared] of [
      ["Model", "string", "model string {\n  x: int32;\n}\n"],
      ["Enum", "int32", "enum int32 {\n  A,\n  B,\n}\n"],
      ["Union", "utcDateTime", "union utcDateTime {\n  int32,\n  boolean,\n}\n"],
    ]) {
      const res = await save(`${entity}${declared}`);
      expect(res.error, kind).toBe(
        `${kind} "${name}" is named like a TypeSpec built-in type: a field typed "${name}" would mean this ${kind.toLowerCase()} instead of the built-in. Choose another name.`,
      );
    }
    nothingWritten();
  });

  it("a name that only looks like one is fine (case matters: String, Int32, Instant)", async () => {
    for (const name of ["String", "Int32", "Instant"]) {
      const res = await save(`model ${name} {\n  @key id: string;\n}\n`);
      expect(res.success, name).toBe(true);
    }
  });
});
