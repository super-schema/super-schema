/**
 * Item-level extensions end to end (spec "Item-level extensions", path C): the Acme `links.items.x-visibility` case.
 * JSON Schema text -> import -> persisted field rows -> generated TypeSpec -> the official @typespec/json-schema and @typespec/openapi3
 * emitters. The extension that sat on the array's `items` must still be in the emitted schema (on the array property, where the field
 * carries it), next to the raw `$ref` of the items and the element constraints the IR cannot hold.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
vi.setConfig({ testTimeout: 60_000 });
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import { compileEntity, type PrismaEntityInput, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

vi.mock("server-only", () => ({}));

const ORG_LIKE = {
  title: "Payment",
  type: "object",
  description: "A payment with HATEOAS links.",
  properties: {
    id: { type: "string" },
    links: {
      type: "array",
      description: "HATEOAS links.",
      items: { $ref: "common_components/v4/schema/json/link_description.json", "x-visibility": { extent: "EXTERNAL" } },
    },
    tags: {
      type: "array",
      items: { type: "string", maxLength: 10, "x-visibility": { extent: "INTERNAL" } },
    },
  },
  required: ["id", "links"],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any> & { name: string; type: string; nullable: boolean; decorators: Record<string, any> };

let rows: Row[];
let warnings: string[];

async function persist(): Promise<void> {
  const parsed = parseJsonSchemaDocument(JSON.stringify(ORG_LIKE));
  if (!parsed.success) throw new Error(parsed.error.message);
  warnings = parsed.data.warnings;
  const payload = buildImportAssetsPayload(toAssetImportResult(parsed.data), {
    domainId: "d", selectedModels: [], selectedEntities: [0], selectedEnums: [], selectedScalars: [],
    selectedUnions: [], selectedServices: [], selectedDecorators: [],
  });
  payload.entities[0].name = "Payment";
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const tx = { entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
  await createImportedEntities(tx, {
    entities: [payload.entities[0] as unknown as ImportedEntityInput],
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p", ownerId: "u", sourceFormat: "jsonschema", isNameFree: async () => true, skip: () => {}, refs: new Map(),
  });
  rows = (create.mock.calls[0][0].data as unknown as { fields: { create: Row[] } }).fields.create;
}

const entity = (): PrismaEntityInput => ({
  id: "e1", name: "Payment", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: undefined,
  domain: { id: "d", name: "Sales", slug: "sales" },
});
const prismaFields = (): PrismaFieldInput[] =>
  rows.map((r, i) => ({
    id: `f${i}`, name: r.name, type: r.type, precision: null, scale: null, nullable: r.nullable, isKey: r.name === "id",
    fieldNumber: null, description: (r.description as string) ?? "", classification: null, aliases: [], decorators: r.decorators, sortOrder: i,
  })) as PrismaFieldInput[];

beforeAll(persist);

describe("links.items.x-visibility survives import -> TypeSpec -> emission", () => {
  it("the import keeps it on the field and says where it came from", () => {
    expect(rows.find((r) => r.name === "links")!.decorators.typespec.extensions.openapi).toEqual({ "x-visibility": { extent: "EXTERNAL" } });
    expect(warnings).toContain("x-visibility found on items of Payment.links was kept on the field");
    expect(warnings).toContain("x-visibility found on items of Payment.tags was kept on the field");
  });

  it("the generated TypeSpec writes the extension pair above the field", () => {
    const text = generateTypeSpec(compileEntity(entity(), prismaFields()), { governance: false });
    expect(text).toContain('@TypeSpec.JsonSchema.extension("x-visibility", #{extent: "EXTERNAL"})');
    expect(text).toContain('@TypeSpec.OpenAPI.extension("x-visibility", #{extent: "EXTERNAL"})');
  });

  it("the emitted JSON Schema has x-visibility on links and tags, the raw items $ref, and the element constraint under its namespaced key", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), prismaFields(), "json-schema");
    expect(result.errors).toEqual([]);
    const schema = JSON.parse(result.output) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.links).toMatchObject({
      type: "array",
      items: { $ref: "common_components/v4/schema/json/link_description.json" },
      "x-visibility": { extent: "EXTERNAL" },
    });
    expect(schema.properties.tags).toMatchObject({
      type: "array", items: { type: "string" }, "x-visibility": { extent: "INTERNAL" }, "x-items-maxLength": 10,
    });
  });

  it("the emitted OpenAPI has them too", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), prismaFields(), "openapi3");
    expect(result.errors).toEqual([]);
    expect(result.output).toContain("x-visibility");
    expect(result.output).toContain("EXTERNAL");
    expect(result.output).toContain("x-items-maxLength");
  });

  it("re-importing the emitted JSON Schema keeps the extension on the field (a second round trip loses nothing)", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), prismaFields(), "json-schema");
    const again = parseJsonSchemaDocument(result.output);
    if (!again.success) throw new Error(again.error.message);
    const links = again.data.entities[0].fields.find((f) => f.name === "links")!;
    expect(links.extensions?.["x-visibility"]).toEqual({ extent: "EXTERNAL" });
  });
});
