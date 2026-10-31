import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities } from "@/services/imported-entities";

// FINAL FIX WAVE 4, I1 (it replaces the final wave 2b rule that SKIPPED such an entity): an import creates the entity under a new name, never
// skips it and never leaves a reference to it dangling. `url`, `int32`, `String`, `Duration`, `Record` are built-in type names; the entity
// is renamed by the events import's rule (`Duration2`), every reference follows, and each rename is a note. A person creating or renaming an
// entity by hand is still refused (entity.service.ts).

function run(
  entities: Array<{ name: string; extends?: string; fields?: Array<{ name: string; type: string; decorators?: Record<string, unknown> }> }>,
  existing: Array<{ name: string; slug: string }> = [],
  sourceFormat?: string
) {
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const findMany = vi.fn(async () => existing);
  const tx = { field: { findMany: vi.fn(async () => []) }, entity: { create, findFirst: vi.fn().mockResolvedValue(null), findMany } } as unknown as Prisma.TransactionClient;
  const skipped: string[] = [];
  const notes: string[] = [];
  const refs = new Map<string, { id: string; productId: string }>();
  const done = createImportedEntities(tx, {
    entities: entities.map((e) => ({
      name: e.name,
      ...(e.extends ? { extends: e.extends } : {}),
      fields: (e.fields ?? []).map((f) => ({ nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, ...f })),
    })),
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p",
    ownerId: "u",
    ...(sourceFormat ? { sourceFormat } : {}),
    isNameFree: async () => true,
    skip: (message) => skipped.push(message),
    note: (message) => notes.push(message),
    refs,
  });
  const written = () => create.mock.calls.map(([arg]) => arg.data as { name: string; slug: string; fields: { create: Array<{ name: string; type: string; decorators?: Record<string, unknown> }> } });
  return { done, create, findMany, skipped, notes, refs, written };
}

describe("createImportedEntities: a built-in type name", () => {
  it("creates an entity named like a built-in type under a numbered name, with a note, and skips nothing", async () => {
    const r = run([{ name: "Order" }, { name: "url" }, { name: "String" }, { name: "Duration" }, { name: "Customer" }]);
    const created = await r.done;
    expect(created.map((c) => c.name)).toEqual(["Order", "url2", "String2", "Duration2", "Customer"]);
    expect(r.skipped).toEqual([]);
    expect(r.notes).toEqual([
      'The entity "url" was renamed to "url2" because "url" is a built-in type name in TypeSpec; every reference to it now says "url2".',
      'The entity "String" was renamed to "String2" because "String" is a built-in type name in TypeSpec/Java/Protobuf/Avro; every reference to it now says "String2".',
      'The entity "Duration" was renamed to "Duration2" because "Duration" is a built-in type name in TypeSpec/Java; every reference to it now says "Duration2".',
    ]);
    expect(r.written().map((d) => [d.name, d.slug])).toEqual([["Order", "order"], ["url2", "url2"], ["String2", "string2"], ["Duration2", "duration2"], ["Customer", "customer"]]);
  });

  it("leaves no reference dangling: a reference field, an array of it, a union member and an extends all name the new name", async () => {
    const r = run([
      { name: "Duration", fields: [{ name: "unit", type: "string" }] },
      { name: "Span", extends: "Duration" },
      {
        name: "Order",
        fields: [
          { name: "timeout", type: "reference", decorators: { referencedEntityName: "Duration" } },
          { name: "history", type: "array", decorators: { referencedEntityName: "Duration", arrayElementType: "reference" } },
          { name: "either", type: "union", decorators: { unionName: "U", unionMembers: ["Duration", "string"] } },
        ],
      },
    ]);
    await r.done;
    const [duration, span, order] = r.written();
    expect(duration!.name).toBe("Duration2");
    expect(order!.fields.create.map((f) => f.decorators)).toEqual([
      { referencedEntityName: "Duration2" },
      { referencedEntityName: "Duration2", arrayElementType: "reference" },
      { unionName: "U", unionMembers: ["Duration2", "string"] },
    ]);
    // the child's parent is looked up by the new name (the entity it extends was created, so `extends` resolved)
    expect(span!.name).toBe("Span");
    expect(r.refs.get("Duration2")).toBeDefined();
    // whatever else of the import still calls it by the name the file gave it finds it too
    expect(r.refs.get("Duration")).toEqual(r.refs.get("Duration2"));
  });

  it("makes a child's parentEntityId the renamed parent", async () => {
    const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
    const tx = { field: { findMany: vi.fn(async () => []) }, entity: { create, findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(async () => []) } } as unknown as Prisma.TransactionClient;
    await createImportedEntities(tx, {
      entities: [
        { name: "Record", fields: [] },
        { name: "Child", extends: "Record", fields: [] },
      ],
      productScope: { tenantId: "t", domainId: "d", productId: "p" }, productId: "p", ownerId: "u",
      isNameFree: async () => true, skip: () => undefined, refs: new Map(),
    });
    expect(create.mock.calls[1]![0].data).toMatchObject({ name: "Child", parentEntityId: "id-Record2" });
  });

  it("takes a number that is free among the product's own entities (names and URL slugs), one query and only when a name needs it", async () => {
    const r = run([{ name: "Duration" }], [{ name: "Duration2", slug: "duration2" }, { name: "Dur", slug: "duration3" }]);
    await r.done;
    expect(r.written()[0]!.name).toBe("Duration4");
    expect(r.findMany).toHaveBeenCalledTimes(1);
    const none = run([{ name: "Order" }]);
    await none.done;
    expect(none.findMany).not.toHaveBeenCalled();
  });

  it("rewrites the type text of a TypeSpec or OpenAPI field, and not of a JSON Schema one", async () => {
    for (const [format, expected] of [["typespec", "Duration2"], ["openapi", "Duration2"], ["json-schema", "Duration"]] as const) {
      const r = run([{ name: "Duration" }, { name: "Order", fields: [{ name: "t", type: "Duration" }] }], [], format);
      await r.done;
      expect(r.written()[1]!.fields.create[0]!.type, format).toBe(expected);
    }
  });

  it("works without a note channel (a caller that does not pass one still gets the rename)", async () => {
    const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
    const tx = { field: { findMany: vi.fn(async () => []) }, entity: { create, findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(async () => []) } } as unknown as Prisma.TransactionClient;
    const created = await createImportedEntities(tx, {
      entities: [{ name: "Map", fields: [] }],
      productScope: { tenantId: "t", domainId: "d", productId: "p" }, productId: "p", ownerId: "u",
      isNameFree: async () => true, skip: () => undefined, refs: new Map(),
    });
    expect(created.map((c) => c.name)).toEqual(["Map2"]);
  });
});
