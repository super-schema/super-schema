import { describe, it, expect, vi } from "vitest";
import { cascadeScalarToFields, linkFieldToEnum, linkFields, linkImportedEntity, pickByName, relinkDanglingFields, relinkDanglingFieldsToEnum, relinkDanglingFieldsToScalar } from "@/services/imported-links";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";

const place = { domain: "CDS", product: "customer" };
const field = (name: string, decorators?: Record<string, unknown>): CreateFieldInput => ({
  name, type: "reference", nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, ...(decorators ? { decorators } : {}),
});
const dangling = (target: string) => ({ referencedEntityName: target, danglingRef: { ref: `../common/${target}.v1.json` } });

describe("linkFields", () => {
  it("replaces the dangling marker of a field whose target exists with a qualified reference", () => {
    const [linked] = linkFields([field("tax_address", dangling("Address"))], new Map([["Address", { id: "e1", name: "Address" }]]), place);
    expect(linked.decorators).toMatchObject({ referencedEntityId: "e1", referencedEntityName: "Address", referencedQualifiedName: "CDS/customer/Address" });
    expect(linked.decorators).not.toHaveProperty("danglingRef");
  });

  it("leaves a field whose target is unknown, and a field that is not dangling, as it is", () => {
    const fields = [field("a", dangling("Missing")), field("b", { referencedEntityName: "Address" }), field("c")];
    expect(linkFields(fields, new Map([["Address", { id: "e1", name: "Address" }]]), place)).toEqual(fields);
  });
});

describe("linkImportedEntity", () => {
  const tx = (entities: Array<{ id: string; name: string; productId?: string }>) => ({
    entity: { findMany: vi.fn().mockResolvedValue(entities.map((e) => ({ productId: "p", ...e }))) },
    product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domainId: "d1", domain: { name: "CDS" } }) },
    sharedEnum: { findMany: vi.fn().mockResolvedValue([]) },
    customScalar: { findMany: vi.fn().mockResolvedValue([]) },
  });

  it("asks nothing when there is nothing to link", async () => {
    const db = tx([]);
    const fields = [field("x")];
    expect(await linkImportedEntity(db as never, { productId: "p", fields })).toEqual({ fields });
    expect(db.entity.findMany).not.toHaveBeenCalled();
  });

  it("links the dangling fields in one lookup", async () => {
    const db = tx([{ id: "ad", name: "Address" }]);
    const result = await linkImportedEntity(db as never, { productId: "p", fields: [field("addr", dangling("Address"))] });
    expect(db.entity.findMany).toHaveBeenCalledTimes(1);
    expect(result.fields[0].decorators).toMatchObject({ referencedEntityId: "ad" });
  });
});

describe("relinkDanglingFields", () => {
  const product = { findUnique: vi.fn().mockResolvedValue({ name: "customer", domainId: "d1", domain: { name: "CDS" } }) };
  const row = (id: string, decorators: unknown, productId = "p") => ({ id, name: id, type: "reference", entityId: `e-${id}`, decorators, entity: { productId } });

  it("links the domain's dangling fields that name the new entity, and only those", async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
      field: { findMany: vi.fn().mockResolvedValue([row("f1", dangling("Address")), row("f2", { referencedEntityName: "Address", referencedEntityId: "x" })]), update },
      entity: { findMany: vi.fn().mockResolvedValue([{ id: "ad", name: "Address", productId: "p" }]) },
      product,
    };
    expect(await relinkDanglingFields(db as never, { productId: "p", entity: { id: "ad", name: "Address" } })).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: "f1" }, data: { decorators: { referencedEntityId: "ad" } } });
  });

  it("matches a file spelling to the asset name (person.json -> Person)", async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
      field: { findMany: vi.fn().mockResolvedValue([row("f1", dangling("country_code".replace("country_code", "person")))]), update },
      entity: { findMany: vi.fn().mockResolvedValue([{ id: "pe", name: "Person", productId: "p" }]) },
      product,
    };
    expect(await relinkDanglingFields(db as never, { productId: "p", entity: { id: "pe", name: "Person" } })).toBe(1);
  });

  it("links a field of ANOTHER product when the entity is the only one of that name in the domain", async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
      field: { findMany: vi.fn().mockResolvedValue([row("f1", dangling("Address"), "other")]), update },
      entity: { findMany: vi.fn().mockResolvedValue([{ id: "ad", name: "Address", productId: "p" }]) },
      product,
    };
    expect(await relinkDanglingFields(db as never, { productId: "p", entity: { id: "ad", name: "Address" } })).toBe(1);
  });

  it("does not guess between several entities of that name in other products", async () => {
    const update = vi.fn();
    const db = {
      field: { findMany: vi.fn().mockResolvedValue([row("f1", dangling("Address"), "third")]), update },
      entity: { findMany: vi.fn().mockResolvedValue([{ id: "ad", name: "Address", productId: "p" }, { id: "ad2", name: "Address", productId: "q" }]) },
      product,
    };
    expect(await relinkDanglingFields(db as never, { productId: "p", entity: { id: "ad", name: "Address" } })).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("pickByName", () => {
  const rows = [{ name: "Address", productId: "a" }, { name: "Address", productId: "b" }, { name: "Person", productId: "a" }];
  it("prefers the field's own product, else a unique match, else nothing", () => {
    expect(pickByName(rows, "address", "b")).toBe(rows[1]);
    expect(pickByName(rows, "person", "z")).toBe(rows[2]);
    expect(pickByName(rows, "address", "z")).toBeUndefined();
    expect(pickByName(rows, "missing", "a")).toBeUndefined();
  });
});

describe("shared scalars", () => {
  const COUNTRY = { name: "CountryCode", baseType: "string", logicalType: "string", pattern: "^[A-Z]{2}$", constraints: { maxLength: 2 } };

  it("links a dangling field to a scalar created afterwards (country_code.json -> CountryCode)", async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
      field: { findMany: vi.fn().mockResolvedValue([
        { id: "f1", name: "c", type: "reference", entityId: "e1", decorators: dangling("country_code"), entity: { productId: "p" } },
        { id: "f2", name: "d", type: "reference", entityId: "e1", decorators: { referencedEntityName: "country_code", referencedEntityId: "x" }, entity: { productId: "p" } },
      ]), update },
    };
    expect(await relinkDanglingFieldsToScalar(db as never, { domainId: "d1", scalar: COUNTRY })).toBe(1);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: "f1" }, data: { type: "string", decorators: { scalarName: "CountryCode", typespec: { validation: { pattern: "^[A-Z]{2}$", maxLength: 2 } } } } });
    expect(update.mock.calls[0][0].data.decorators).not.toHaveProperty("danglingRef");
  });

  it("is looked for among the domain's scalars when neither an entity nor an enum has the name", async () => {
    const db = {
      entity: { findMany: vi.fn().mockResolvedValue([]) },
      product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domainId: "d1", domain: { name: "CDS" } }) },
      sharedEnum: { findMany: vi.fn().mockResolvedValue([]) },
      customScalar: { findMany: vi.fn().mockResolvedValue([COUNTRY]) },
    };
    const result = await linkImportedEntity(db as never, { productId: "p", fields: [field("c", dangling("country_code"))] });
    expect(result.fields[0].type).toBe("string");
    expect(result.fields[0].decorators).toMatchObject({ scalarName: "CountryCode" });
  });

  it("editing a scalar re-derives every field that records it and flags the entities", async () => {
    const update = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({});
    const db = {
      field: {
        findMany: vi.fn().mockResolvedValue([
          { id: "f1", entityId: "e1", type: "string", decorators: { scalarName: "CountryCode", typespec: { validation: { maxLength: 2, pattern: "^[A-Z]{2}$" } } } },
          { id: "f2", entityId: "e2", type: "string", decorators: { scalarName: "CountryCode", typespec: { validation: { maxLength: 3, pattern: "^[A-Z]{3}$" } } } },
        ]),
        update,
      },
      entity: { updateMany },
    };
    await cascadeScalarToFields(db as never, { domainId: "d1", scalar: { name: "CountryCode", baseType: "string", pattern: "^[A-Z]{3}$", constraints: { maxLength: 3 } } });
    expect(update).toHaveBeenCalledTimes(1); // f2 already matches
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: "f1" } });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: ["e1"] } }, data: { hasUnpublishedChanges: true } });
  });
});

describe("a dangling reference to an enum file", () => {
  const ORTHOGRAPHY = { name: "Orthography", values: ["Latn", "Cyrl"] };
  const elementOf = (target: string) => ({ referencedEntityName: target, danglingRef: { ref: `${target}.v1.json`, element: true } });

  it("makes a direct reference an enum field carrying the symbols, with no reference left", () => {
    const linked = linkFieldToEnum(field("orthography", dangling("Orthography")), ORTHOGRAPHY);
    expect(linked.type).toBe("enum");
    expect(linked.decorators).toMatchObject({ enumName: "Orthography", typespec: { validation: { pattern: "Latn|Cyrl" } } });
    expect(linked.decorators).not.toHaveProperty("danglingRef");
    expect(linked.decorators).not.toHaveProperty("referencedEntityName");
  });

  it("keeps the validation and typespec facts the field already had", () => {
    const linked = linkFieldToEnum(field("o", { ...dangling("Orthography"), typespec: { validation: { minLength: 1 }, documentation: { summary: "s" } } }), ORTHOGRAPHY);
    expect(linked.decorators).toMatchObject({ typespec: { validation: { minLength: 1, pattern: "Latn|Cyrl" }, documentation: { summary: "s" } } });
  });

  it("makes an array of references an array of enum symbols", () => {
    const linked = linkFieldToEnum({ ...field("scripts", elementOf("Orthography")), type: "array" }, ORTHOGRAPHY);
    expect(linked.type).toBe("array");
    expect(linked.decorators).toMatchObject({ arrayElementType: "enum", enumValues: ["Latn", "Cyrl"], enumName: "Orthography" });
    expect(linked.decorators).not.toHaveProperty("danglingRef");
  });

  it("leaves a field that is not dangling as it is", () => {
    const plain = field("x", { referencedEntityName: "Orthography" });
    expect(linkFieldToEnum(plain, ORTHOGRAPHY)).toBe(plain);
  });

  it("is looked for in the domain's shared enums when no entity has the name, and only then", async () => {
    const db = {
      entity: { findMany: vi.fn().mockResolvedValue([{ id: "ad", name: "Address", productId: "p" }]) },
      product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domainId: "d1", domain: { name: "CDS" } }) },
      sharedEnum: { findMany: vi.fn().mockResolvedValue([ORTHOGRAPHY]) },
      customScalar: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const result = await linkImportedEntity(db as never, { productId: "p", fields: [field("addr", dangling("Address")), field("o", dangling("Orthography"))] });
    expect(db.sharedEnum.findMany).toHaveBeenCalledWith({ where: { domainId: "d1" }, select: { name: true, values: true, valueDescriptions: true } });
    expect(result.fields[0].decorators).toMatchObject({ referencedEntityId: "ad" });
    expect(result.fields[1].type).toBe("enum");
  });

  it("is not looked for when every name was an entity", async () => {
    const db = {
      entity: { findMany: vi.fn().mockResolvedValue([{ id: "ad", name: "Address", productId: "p" }]) },
      product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domainId: "d1", domain: { name: "CDS" } }) },
      sharedEnum: { findMany: vi.fn() },
      customScalar: { findMany: vi.fn() },
    };
    await linkImportedEntity(db as never, { productId: "p", fields: [field("addr", dangling("Address"))] });
    expect(db.sharedEnum.findMany).not.toHaveBeenCalled();
  });

  it("relinks the domain's dangling fields when the enum is created afterwards", async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
      field: {
        findMany: vi.fn().mockResolvedValue([
          { id: "f1", name: "o", type: "reference", decorators: dangling("Orthography") },
          { id: "f2", name: "p", type: "reference", decorators: { referencedEntityName: "Orthography", referencedEntityId: "x" } },
        ]),
        update,
      },
    };
    expect(await relinkDanglingFieldsToEnum(db as never, { domainId: "d1", enum: ORTHOGRAPHY })).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: "f1" }, data: { type: "enum", decorators: { enumName: "Orthography" } } });
  });
});
