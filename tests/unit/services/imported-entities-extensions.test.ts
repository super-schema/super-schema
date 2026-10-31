import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";

// Vendor extensions of an import reach Entity.metadata.custom.extensions (a flat record) on create; field extensions travel in the
// field's decorators (decorators.typespec.extensions.openapi) and need no entity-side wiring.

type Written = { metadata?: Record<string, unknown>; fields: { create: Array<Record<string, unknown>> } };

async function persist(entity: Record<string, unknown>, sourceFormat?: string): Promise<Written> {
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const tx = { field: { findMany: vi.fn(async () => []) }, entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
  await createImportedEntities(tx, {
    entities: [{ name: "Order", fields: [], ...entity } as ImportedEntityInput],
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p",
    ownerId: "u",
    sourceFormat,
    isNameFree: async () => true,
    skip: () => {},
    refs: new Map(),
  });
  return create.mock.calls[0][0].data as unknown as Written;
}

describe("createImportedEntities: entity extensions", () => {
  it("stores a flat extensions record at metadata.custom.extensions next to tags and sourceFormat", async () => {
    const data = await persist({ tags: ["a"], extensions: { "x-links": [{ rel: "self" }], "x-owner": "team" } }, "jsonschema");
    expect(data.metadata).toEqual({
      tags: ["a"],
      sourceFormat: "jsonschema",
      custom: { extensions: { "x-links": [{ rel: "self" }], "x-owner": "team" } },
    });
  });

  it("writes no metadata for empty extensions", async () => {
    expect((await persist({ extensions: {} })).metadata).toBeUndefined();
  });

  it.each([[null], [["x-a"]], ["x-a"], [42], [true]])("ignores a non-object extensions value (%j)", async (bad) => {
    expect((await persist({ extensions: bad })).metadata).toBeUndefined();
  });

  it("never persists x-tags / x-classification into the generic bag", async () => {
    const data = await persist({ extensions: { "x-tags": ["t"], "x-classification": "PII", "x-keep": 1 } });
    expect(data.metadata).toEqual({ custom: { extensions: { "x-keep": 1 } } });
    expect((await persist({ extensions: { "x-tags": ["t"] } })).metadata).toBeUndefined();
  });

  it("keeps a __proto__ key as an own data key and does not pollute prototypes", async () => {
    const extensions = JSON.parse('{"__proto__":{"isAdmin":true},"x-a":1}');
    const data = await persist({ extensions });
    const stored = (data.metadata?.custom as { extensions: Record<string, unknown> }).extensions;
    expect(Object.keys(stored).sort()).toEqual(["__proto__", "x-a"]);
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });
});

describe("import -> persist -> read back -> generate TypeSpec", () => {
  it("round-trips entity and field extensions to JsonSchema + OpenAPI extension decorators", async () => {
    const parsed = parseJsonSchemaDocument(
      JSON.stringify({
        title: "Thing",
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, legacy: { type: "string", "x-visibility": { level: "internal" } } },
        "x-links": [{ rel: "self", href: "https://x" }],
      }),
    );
    if (!parsed.success) throw new Error(parsed.error.message);
    const result = toAssetImportResult(parsed.data);
    const payload = buildImportAssetsPayload(result, {
      domainId: "d", selectedModels: [], selectedEntities: [0], selectedEnums: [], selectedScalars: [],
      selectedUnions: [], selectedServices: [], selectedDecorators: [],
    });
    expect(payload.entities[0].extensions).toEqual({ "x-links": [{ rel: "self", href: "https://x" }] });

    const data = await persist(payload.entities[0] as unknown as Record<string, unknown>, "jsonschema");
    const rows = data.fields.create;
    const legacy = rows.find((r) => r.name === "legacy") as { decorators: { typespec: { extensions: { openapi: unknown } } } };
    expect(legacy.decorators.typespec.extensions.openapi).toEqual({ "x-visibility": { level: "internal" } });

    const source = generateTypeSpec(
      compileEntity(
        { id: "e", name: "Thing", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: data.metadata, domain: { id: "d", name: "Sales", slug: "sales" } },
        rows.map((r, i) => ({
          id: `f${i}`, name: r.name as string, type: r.type as string, precision: null, scale: null,
          nullable: r.nullable as boolean, isKey: r.isKey as boolean, fieldNumber: null, description: "", classification: null,
          aliases: [], decorators: r.decorators, sortOrder: i,
        })),
      ),
      { governance: false },
    );
    for (const key of ["x-links", "x-visibility"]) {
      expect(source).toContain(`@TypeSpec.JsonSchema.extension("${key}"`);
      expect(source).toContain(`@TypeSpec.OpenAPI.extension("${key}"`);
    }
  });
});
