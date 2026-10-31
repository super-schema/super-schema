/**
 * What an entity's own schema node carries beyond its properties: `deprecated`, `$id`, `$schema` (and a definition's `title`). `deprecated`
 * is the entity's deprecation metadata; `$id` / `$schema` are kept as entity extensions, reported as not interpreted, and never written back
 * into a generated schema (the generated documents have their own, and an `$id` would re-base their relative `$ref`s).
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Prisma } from "@/generated/prisma/client";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { entityExtensionsChange } from "@/lib/typespec-sync/merge-fields";

function importDoc(schema: unknown) {
  const r = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

const doc = importDoc({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.com/schemas/r.json",
  title: "R", type: "object", deprecated: true, properties: { a: { type: "string" } },
  $defs: {
    Child: { $id: "child.json", $schema: "http://json-schema.org/draft-07/schema#", title: "A child", deprecated: true, "x-c": 1, type: "object", properties: { z: { type: "string" } } },
    Same: { title: "Same", type: "object", properties: { q: { type: "string" } } },
  },
});
const entity = (name: string) => doc.entities.find((e) => e.name === name)!;

describe("the root entity", () => {
  it("keeps $id and $schema as extensions, lists them as not interpreted, and is deprecated", () => {
    expect(entity("R").extensions).toEqual({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://example.com/schemas/r.json" });
    expect(entity("R").ignoredKeywords).toEqual(["$schema", "$id"]);
    expect(entity("R").deprecated).toBe(true);
    // dialect + identity are metadata: kept and listed, never a warning
    expect(doc.warnings.some((w) => w.startsWith("Entity `R`") && (w.includes("`$schema`") || w.includes("`$id`")))).toBe(false);
  });
});

describe("a definition's entity", () => {
  it("keeps $schema, a title that says more than the name, vendor keys; is deprecated; its $id is the resource id its $refs use", () => {
    expect(entity("Child").extensions).toEqual({ "x-c": 1, $schema: "http://json-schema.org/draft-07/schema#", title: "A child" });
    expect(entity("Child").deprecated).toBe(true);
    expect(doc.warnings.some((w) => w.startsWith("Entity `Child`") && (w.includes("`$schema`") || w.includes("$id")))).toBe(false);
  });

  it("a title equal to the name adds nothing; nothing special: nothing kept", () => {
    expect(entity("Same").extensions).toBeUndefined();
    expect(entity("Same").deprecated).toBeUndefined();
  });
});

describe("persisting", () => {
  const persisted = async () => {
    const payload = buildImportAssetsPayload(toAssetImportResult(doc), {
      domainId: "d", selectedModels: [], selectedEntities: [0, 1, 2], selectedEnums: [], selectedScalars: [],
      selectedUnions: [], selectedServices: [], selectedDecorators: [],
    });
    const created: Array<{ name: string; metadata?: Record<string, unknown> }> = [];
    const create = vi.fn(async ({ data }: { data: { name: string; metadata?: Record<string, unknown> } }) => {
      created.push(data);
      return { id: `id-${data.name}` };
    });
    const tx = { field: { findMany: vi.fn(async () => []) }, entity: { create, findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(async () => []) } } as unknown as Prisma.TransactionClient;
    await createImportedEntities(tx, {
      entities: payload.entities as unknown as ImportedEntityInput[],
      productScope: { tenantId: "t", domainId: "d", productId: "p" },
      productId: "p", ownerId: "u", sourceFormat: "jsonschema", isNameFree: async () => true, skip: () => {}, refs: new Map(),
    });
    return created;
  };

  it("a deprecated entity gets the entity's deprecation metadata; $id / $schema are stored as extensions", async () => {
    const [r, child, same] = await persisted();
    expect(r.metadata).toMatchObject({
      deprecation: { deprecated: true },
      custom: { extensions: { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://example.com/schemas/r.json" } },
    });
    expect(child.metadata).toMatchObject({ deprecation: { deprecated: true } });
    expect(same.metadata).not.toHaveProperty("deprecation");
  });
});

describe("generating", () => {
  const model = compileEntity(
    {
      id: "e", name: "R", description: "", status: "DRAFT", version: 1, domainId: "d", domain: { id: "d", name: "D", slug: "d" },
      metadata: { custom: { extensions: { $id: "https://example.com/r.json", $schema: "http://json-schema.org/draft-07/schema#", "x-keep": 1 } } },
    },
    []
  );

  it("never writes $id / $schema into the TypeSpec (they would replace the generated document's own), vendor keys stay", () => {
    const text = generateTypeSpec(model, { governance: false });
    expect(text).toContain('"x-keep"');
    expect(text).not.toContain("$id");
    expect(text).not.toContain("$schema");
  });

  it("a Save of that source keeps them in the stored extensions", () => {
    const stored = { custom: { extensions: { $id: "https://example.com/r.json", $schema: "s", "x-keep": 1 } } };
    expect(entityExtensionsChange(stored, { "x-keep": 1 })).toEqual({ kind: "none" });
    expect(entityExtensionsChange(stored, { "x-keep": 2 })).toEqual({ kind: "set", value: { "x-keep": 2, $id: "https://example.com/r.json", $schema: "s" } });
    expect(entityExtensionsChange(stored, {})).toEqual({ kind: "set", value: { $id: "https://example.com/r.json", $schema: "s" } });
  });
});
