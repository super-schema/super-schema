import { describe, it, expect, vi } from "vitest";
import { adoptBaseFields, linkFields, linkImportedEntity, relinkDanglingFields } from "@/services/imported-links";
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
    field: { findMany: vi.fn().mockResolvedValue([]) },
    product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domain: { name: "CDS" } }) },
  });

  it("asks nothing when there is nothing to link", async () => {
    const db = tx([]);
    const fields = [field("x")];
    expect(await linkImportedEntity(db as never, { productId: "p", fields })).toEqual({ fields });
    expect(db.entity.findMany).not.toHaveBeenCalled();
  });

  it("links the base and the dangling fields in one lookup", async () => {
    const db = tx([{ id: "pn", name: "PersonName" }, { id: "ad", name: "Address" }]);
    const result = await linkImportedEntity(db as never, { productId: "p", fields: [field("addr", dangling("Address"))], extends: "PersonName" });
    expect(db.entity.findMany).toHaveBeenCalledTimes(1);
    expect(result.parentEntityId).toBe("pn");
    expect(result.fields[0].decorators).toMatchObject({ referencedEntityId: "ad" });
  });

  it("copies the base's fields in front of the entity's own, an own field of the same name winning", async () => {
    const db = {
      ...tx([{ id: "pn", name: "PersonName" }]),
      field: { findMany: vi.fn().mockResolvedValue([
        { name: "given_name", type: "string", nullable: false, isKey: false, description: "g", classification: null, precision: null, scale: null, fieldNumber: null, aliases: [], decorators: {} },
        { name: "surname", type: "string", nullable: true, isKey: false, description: "base surname", classification: null, precision: null, scale: null, fieldNumber: null, aliases: [], decorators: { x: 1 } },
      ]) },
    };
    const own = { ...field("surname"), type: "string", description: "own surname" };
    const result = await linkImportedEntity(db as never, { productId: "p", fields: [own, { ...field("suffix"), type: "string" }], extends: "PersonName" });
    expect(result.fields.map((f) => f.name)).toEqual(["given_name", "surname", "suffix"]);
    expect(result.fields[1].description).toBe("own surname");
    expect(result.inherited).toEqual({ from: "PersonName", count: 1 });
    expect(result.parentEntityId).toBe("pn");
  });

  it("leaves a base the product does not have unlinked", async () => {
    const result = await linkImportedEntity(tx([]) as never, { productId: "p", fields: [], extends: "PersonName" });
    expect(result.parentEntityId).toBeUndefined();
  });
});

describe("relinkDanglingFields", () => {
  it("links the product's dangling fields that name the new entity, and only those", async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
      field: {
        findMany: vi.fn().mockResolvedValue([
          { id: "f1", decorators: dangling("Address") },
          { id: "f2", decorators: { referencedEntityName: "Address", referencedEntityId: "x" } },
        ]),
        update,
      },
      product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domain: { name: "CDS" } }) },
    };
    expect(await relinkDanglingFields(db as never, { productId: "p", entity: { id: "ad", name: "Address" } })).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: "f1" }, data: { decorators: { referencedEntityId: "ad" } } });
    expect(update.mock.calls[0][0].data.decorators).not.toHaveProperty("danglingRef");
  });
});

describe("a base that is not in the product yet", () => {
  it("is remembered on the entity", async () => {
    const db = { entity: { findMany: vi.fn().mockResolvedValue([]) }, field: { findMany: vi.fn() }, product: { findUnique: vi.fn() } };
    const result = await linkImportedEntity(db as never, { productId: "p", fields: [], extends: "PersonName" });
    expect(result.pendingBase).toBe("PersonName");
    expect(result.parentEntityId).toBeUndefined();
  });
});

describe("adoptBaseFields", () => {
  const row = (name: string) => ({ name, type: "string", nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, fieldNumber: null, aliases: [], decorators: {} });

  it("copies the new entity's fields in front of those of an entity that was waiting for it, links it, and clears the wait", async () => {
    const create = vi.fn().mockResolvedValue({});
    const db = {
      entity: {
        findMany: vi.fn().mockResolvedValue([{ id: "c1", name: "LegalName", metadata: { sourceFormat: "json-schema", pendingBase: "PersonName" } }]),
        update: vi.fn().mockResolvedValue({}),
      },
      field: {
        findMany: vi.fn().mockImplementation(async (arg: { where: { entityId: string } }) => (arg.where.entityId === "pn" ? [row("given_name"), row("surname")] : [{ name: "surname" }])),
        updateMany: vi.fn().mockResolvedValue({}),
        create,
      },
    };
    const done = await adoptBaseFields(db as never, { productId: "p", entity: { id: "pn", name: "PersonName" } });
    expect(done).toEqual(["LegalName"]);
    expect(db.field.updateMany).toHaveBeenCalledWith({ where: { entityId: "c1" }, data: { sortOrder: { increment: 1 } } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({ name: "given_name", sortOrder: 0, entity: { connect: { id: "c1" } } });
    expect(db.entity.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { parentEntityId: "pn", metadata: { sourceFormat: "json-schema" } } });
  });

  it("does nothing when no entity waits for it", async () => {
    const db = { entity: { findMany: vi.fn().mockResolvedValue([]) }, field: { findMany: vi.fn() } };
    expect(await adoptBaseFields(db as never, { productId: "p", entity: { id: "pn", name: "PersonName" } })).toEqual([]);
    expect(db.field.findMany).not.toHaveBeenCalled();
  });
});
