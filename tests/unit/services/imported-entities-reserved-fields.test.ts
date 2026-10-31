import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { createImportedEntities, type CreateImportedEntitiesArgs } from "@/services/imported-entities";

// The shared entity loop of the bulk schema import (JSON Schema / Avro / Protobuf / TypeSpec importers and the AsyncAPI importer): a field
// whose name the AsyncAPI parser cannot read (`PARSER_UNSAFE_KEYS`) is renamed (`name_1`, `name_2` ...), with a note, never dropped or
// refused: the import still delivers the entity.

const field = (name: string, extra: Partial<CreateFieldInput> = {}): CreateFieldInput => ({
  name, type: "string", nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, ...extra,
});

function run(fields: CreateFieldInput[], overrides: Partial<CreateImportedEntitiesArgs> = {}) {
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const tx = { field: { findMany: vi.fn(async () => []) }, entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
  const notes: string[] = [];
  const skipped: string[] = [];
  const done = createImportedEntities(tx, {
    entities: [{ name: "Order", fields }],
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p",
    ownerId: "u",
    isNameFree: async () => true,
    skip: (message) => skipped.push(message),
    note: (message) => notes.push(message),
    refs: new Map(),
    ...overrides,
  });
  const written = async () => {
    await done;
    const data = create.mock.calls[0][0].data as unknown as { fields: { create: Array<{ name: string; slug: string }> } };
    return data.fields.create.map((f) => [f.name, f.slug]);
  };
  return { done, written, notes, skipped };
}

describe("createImportedEntities: a reserved field name", () => {
  it("renames hasOwnProperty to hasOwnProperty_1, writes the slug of the new name, and notes it", async () => {
    const r = run([field("id"), field("hasOwnProperty")]);
    expect(await r.written()).toEqual([["id", "id"], ["hasOwnProperty_1", "hasownproperty-1"]]);
    expect(r.notes).toEqual(['The field "hasOwnProperty" was renamed to "hasOwnProperty_1": the name is reserved. It belongs to the entity "Order".']);
    expect(r.skipped).toEqual([]);
  });

  it("goes on to _2 when _1 is taken by another field, in either order", async () => {
    expect((await run([field("hasOwnProperty"), field("hasOwnProperty_1")]).written()).map(([n]) => n)).toEqual(["hasOwnProperty_2", "hasOwnProperty_1"]);
    expect((await run([field("hasOwnProperty_1"), field("hasOwnProperty")]).written()).map(([n]) => n)).toEqual(["hasOwnProperty_1", "hasOwnProperty_2"]);
  });

  it("trims a padded name before renaming it", async () => {
    expect((await run([field(" hasOwnProperty ")]).written()).map(([n]) => n)).toEqual(["hasOwnProperty_1"]);
  });

  it("leaves hasownproperty, HasOwnProperty and hasOwnProperty2 alone, and notes nothing", async () => {
    const r = run([field("hasownproperty"), field("HasOwnProperty2"), field("hasOwnProperty2")]);
    expect((await r.written()).map(([n]) => n)).toEqual(["hasownproperty", "HasOwnProperty2", "hasOwnProperty2"]);
    expect(r.notes).toEqual([]);
  });

  it("keeps the rest of the field (type, key flag, field number, order) and still creates the entity", async () => {
    const create = vi.fn(async () => ({ id: "e1" }));
    const tx = { field: { findMany: vi.fn(async () => []) }, entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
    const created = await createImportedEntities(tx, {
      entities: [{ name: "Order", fields: [field("hasOwnProperty", { type: "int32", isKey: true, fieldNumber: 7 })] }],
      productScope: { tenantId: "t", domainId: "d", productId: "p" }, productId: "p", ownerId: "u",
      isNameFree: async () => true, skip: () => undefined, refs: new Map(),
    });
    expect(created).toEqual([{ id: "e1", name: "Order" }]);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ fields: { create: [expect.objectContaining({ name: "hasOwnProperty_1", type: "int32", isKey: true, fieldNumber: 7, sortOrder: 0 })] } }) });
  });

  it("works without a note channel (a caller that does not pass one still gets the rename)", async () => {
    const r = run([field("hasOwnProperty")], { note: undefined });
    expect((await r.written()).map(([n]) => n)).toEqual(["hasOwnProperty_1"]);
  });
});

describe("createImportedEntities: a reserved ENTITY name", () => {
  /** Every entity of the batch is written; returns what the loop created and what it told. */
  async function runBatch(entities: CreateImportedEntitiesArgs["entities"], overrides: Partial<CreateImportedEntitiesArgs> = {}) {
    const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
    const tx = { field: { findMany: vi.fn(async () => []) }, entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
    const notes: string[] = [];
    const asked: string[] = [];
    const refs = new Map<string, { id: string; productId: string }>();
    const created = await createImportedEntities(tx, {
      entities, productScope: { tenantId: "t", domainId: "d", productId: "p" }, productId: "p", ownerId: "u",
      isNameFree: async (name) => { asked.push(name); return true; }, skip: () => undefined, note: (m) => notes.push(m), refs, ...overrides,
    });
    const written = create.mock.calls.map(([arg]) => arg.data as unknown as { name: string; parentEntityId?: string; fields: { create: Array<{ name: string; decorators?: Record<string, unknown> }> } });
    return { created, notes, asked, written, refs };
  }

  it("renames it to hasOwnProperty_1, checks THAT name in the registry, and says so", async () => {
    const r = await runBatch([{ name: "hasOwnProperty", fields: [field("id")] }]);
    expect(r.created).toEqual([{ id: "id-hasOwnProperty_1", name: "hasOwnProperty_1" }]);
    expect(r.asked).toEqual(["hasOwnProperty_1"]);
    expect(r.notes).toEqual(['The entity "hasOwnProperty" was renamed to "hasOwnProperty_1": the name is reserved.']);
  });

  it("goes on to _2 when _1 is another entity of the batch (compared case-insensitively), and trims a padded name", async () => {
    const r = await runBatch([{ name: " hasOwnProperty ", fields: [] }, { name: "HASOWNPROPERTY_1", fields: [] }]);
    expect(r.written.map((w) => w.name)).toEqual(["hasOwnProperty_2", "HASOWNPROPERTY_1"]);
  });

  it("an entity that extends it, and a field that refers to it, follow the new name; the import's own name still finds the entity in refs", async () => {
    const r = await runBatch([
      { name: "hasOwnProperty", fields: [field("id")] },
      { name: "Child", extends: "hasOwnProperty", fields: [
        field("parent", { type: "reference", decorators: { referencedEntityName: "hasOwnProperty" } }),
        field("many", { type: "array", decorators: { arrayElementType: "hasOwnProperty", referencedEntityName: "Other" } }),
      ] },
    ]);
    const child = r.written[1];
    expect(child.parentEntityId).toBe("id-hasOwnProperty_1");
    expect(child.fields.create.map((f) => f.decorators)).toEqual([{ referencedEntityName: "hasOwnProperty_1" }, { arrayElementType: "hasOwnProperty_1", referencedEntityName: "Other" }]);
    expect(r.refs.get("hasOwnProperty")?.id).toBe("id-hasOwnProperty_1");
    expect(r.refs.get("hasOwnProperty_1")?.id).toBe("id-hasOwnProperty_1");
  });

  it("two entities with the SAME reserved name (the second is a duplicate) get ONE new name, reported once: the first is created, the second is skipped as already there", async () => {
    const takenNames = new Set<string>();
    const skipped: string[] = [];
    const r = await runBatch(
      [{ name: "hasOwnProperty", fields: [] }, { name: "Child", extends: "hasOwnProperty", fields: [] }, { name: "hasOwnProperty", fields: [] }, { name: "hasOwnProperty_1", fields: [] }],
      {
        isNameFree: async (name) => {
          if (takenNames.has(name)) { skipped.push(`"${name}" is already used`); return false; }
          takenNames.add(name);
          return true;
        },
      },
    );
    expect(r.created.map((c) => c.name)).toEqual(["hasOwnProperty_2", "Child", "hasOwnProperty_1"]);
    expect(r.notes).toEqual(['The entity "hasOwnProperty" was renamed to "hasOwnProperty_2": the name is reserved.']);
    expect(skipped).toEqual(['"hasOwnProperty_2" is already used']);
    expect(r.written[1].parentEntityId).toBe("id-hasOwnProperty_2");
  });

  it("leaves hasownproperty, HasOwnProperty and hasOwnProperty2 alone, and notes nothing", async () => {
    const r = await runBatch([{ name: "hasownproperty", fields: [] }, { name: "HasOwnProperty", fields: [] }, { name: "hasOwnProperty2", fields: [] }]);
    expect(r.written.map((w) => w.name)).toEqual(["hasownproperty", "HasOwnProperty", "hasOwnProperty2"]);
    expect(r.notes).toEqual([]);
  });
});
