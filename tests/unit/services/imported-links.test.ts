import { describe, it, expect, vi } from "vitest";
import { linkFieldToEnum, linkFields, linkImportedEntity, relinkDanglingFields, relinkDanglingFieldsToEnum } from "@/services/imported-links";
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
  const tx = (entities: Array<{ id: string; name: string }>) => ({
    entity: { findMany: vi.fn().mockResolvedValue(entities) },
    product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domainId: "d1", domain: { name: "CDS" } }) },
    sharedEnum: { findMany: vi.fn().mockResolvedValue([]) },
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
  it("links the product's dangling fields that name the new entity, and only those", async () => {
    const update = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const db = {
      field: {
        findMany: vi.fn().mockResolvedValue([
          { id: "f1", entityId: "e-other", name: "tax", type: "reference", decorators: dangling("Address") },
          { id: "f2", entityId: "e-other", name: "ship", type: "reference", decorators: { referencedEntityName: "Address", referencedEntityId: "x" } },
        ]),
        update,
      },
      product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domain: { name: "CDS" } }) },
      auditLog: { create: auditCreate },
    };
    expect(
      await relinkDanglingFields(db as never, { productId: "p", entity: { id: "ad", name: "Address" }, actor: { userId: "u1", tenantId: "t1" } })
    ).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: "f1" }, data: { decorators: { referencedEntityId: "ad" } } });
    expect(update.mock.calls[0][0].data.decorators).not.toHaveProperty("danglingRef");
  });

  it("records each relinked field as an UPDATE of that field, under the acting user and tenant, with its states", async () => {
    const auditCreate = vi.fn().mockResolvedValue({});
    const db = {
      field: {
        findMany: vi.fn().mockResolvedValue([{ id: "f1", entityId: "e-other", name: "tax", type: "reference", decorators: dangling("Address") }]),
        update: vi.fn().mockResolvedValue({}),
      },
      product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domain: { name: "CDS" } }) },
      auditLog: { create: auditCreate },
    };
    await relinkDanglingFields(db as never, { productId: "p", entity: { id: "ad", name: "Address" }, actor: { userId: "u1", tenantId: "t1" } });

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const { data } = auditCreate.mock.calls[0][0];
    expect(data).toMatchObject({ action: "UPDATE", entityType: "Field", entityId: "f1", userId: "u1", tenantId: "t1" });
    expect(data.beforeState).toMatchObject({ id: "f1", entityId: "e-other", name: "tax", decorators: dangling("Address") });
    expect(data.afterState).toMatchObject({ id: "f1", decorators: { referencedEntityId: "ad" } });
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
      entity: { findMany: vi.fn().mockResolvedValue([{ id: "ad", name: "Address" }]) },
      product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domainId: "d1", domain: { name: "CDS" } }) },
      sharedEnum: { findMany: vi.fn().mockResolvedValue([ORTHOGRAPHY]) },
    };
    const result = await linkImportedEntity(db as never, { productId: "p", fields: [field("addr", dangling("Address")), field("o", dangling("Orthography"))] });
    expect(db.sharedEnum.findMany).toHaveBeenCalledWith({ where: { domainId: "d1", name: { in: ["Orthography"] } }, select: { name: true, values: true } });
    expect(result.fields[0].decorators).toMatchObject({ referencedEntityId: "ad" });
    expect(result.fields[1].type).toBe("enum");
  });

  it("is not looked for when every name was an entity", async () => {
    const db = {
      entity: { findMany: vi.fn().mockResolvedValue([{ id: "ad", name: "Address" }]) },
      product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domainId: "d1", domain: { name: "CDS" } }) },
      sharedEnum: { findMany: vi.fn() },
    };
    await linkImportedEntity(db as never, { productId: "p", fields: [field("addr", dangling("Address"))] });
    expect(db.sharedEnum.findMany).not.toHaveBeenCalled();
  });

  it("relinks the domain's dangling fields when the enum is created afterwards", async () => {
    const update = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const db = {
      field: {
        findMany: vi.fn().mockResolvedValue([
          { id: "f1", entityId: "e-other", name: "o", type: "reference", decorators: dangling("Orthography") },
          { id: "f2", entityId: "e-other", name: "p", type: "reference", decorators: { referencedEntityName: "Orthography", referencedEntityId: "x" } },
        ]),
        update,
      },
      auditLog: { create: auditCreate },
    };
    expect(await relinkDanglingFieldsToEnum(db as never, { domainId: "d1", enum: ORTHOGRAPHY, actor: { userId: "u1", tenantId: "t1" } })).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: "f1" }, data: { type: "enum", decorators: { enumName: "Orthography" } } });

    // the change of the field's own row is recorded too, so the entity's Change Log shows it
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: "UPDATE",
      entityType: "Field",
      entityId: "f1",
      userId: "u1",
      tenantId: "t1",
      afterState: { id: "f1", type: "enum", decorators: { enumName: "Orthography" } },
    });
  });
});
