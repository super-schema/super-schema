import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { parseAvroDocument } from "@/lib/importers/avro.importer";
import { parseProtobufDocument } from "@/lib/importers/protobuf.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { mapDocumentToImportResult, type TypeSpecImportResult } from "@/lib/importers/typespec.importer";
import { compileTypeSpecDocument } from "@/lib/compiler/typespec-compiler";
import { convertOpenAPI3Document } from "@typespec/openapi3";

// FINAL FIX WAVE 4, I1, one test per importer path: a document that defines an entity named `Duration` (a TypeSpec / Java built-in) and another
// entity that refers to it (a field, an array of it) is imported WHOLE: the entity is created as `Duration2`, the references name it, and the
// note says so. Before, the entity was skipped and `Order.timeout` named an entity that did not exist.

type Written = { name: string; fields: { create: Array<{ name: string; type: string; decorators?: Record<string, unknown> }> } };

async function persist(result: TypeSpecImportResult) {
  const payload = buildImportAssetsPayload(result, {
    domainId: "d", selectedModels: [], selectedEntities: result.models.map((_, i) => i), selectedEnums: [], selectedScalars: [],
    selectedUnions: [], selectedServices: [], selectedDecorators: [],
  });
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const tx = { field: { findMany: vi.fn(async () => []) }, entity: { create, findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(async () => []) } } as unknown as Prisma.TransactionClient;
  const skipped: string[] = [];
  const notes: string[] = [];
  await createImportedEntities(tx, {
    entities: payload.entities as unknown as ImportedEntityInput[],
    productScope: { tenantId: "t", domainId: "d", productId: "p" }, productId: "p", ownerId: "u", sourceFormat: payload.sourceFormat,
    isNameFree: async () => true, skip: (m) => skipped.push(m), note: (m) => notes.push(m), refs: new Map(),
  });
  const written = create.mock.calls.map(([arg]) => arg.data as unknown as Written);
  return { written, skipped, notes, byName: (name: string) => written.find((w) => w.name === name) };
}

const NOTE = 'The entity "Duration" was renamed to "Duration2" because "Duration" is a built-in type name in TypeSpec/Java; every reference to it now says "Duration2".';

function expectWhole(r: Awaited<ReturnType<typeof persist>>) {
  expect(r.skipped).toEqual([]);
  expect(r.written.map((w) => w.name)).toContain("Duration2");
  expect(r.written.map((w) => w.name)).not.toContain("Duration");
  expect(r.notes).toContain(NOTE);
}

describe("an entity named like a built-in type, per importer", () => {
  it("JSON Schema: $defs Duration and Order, Order.timeout and Order.history refer to it", async () => {
    const parsed = parseJsonSchemaDocument(
      JSON.stringify({
        title: "Shop",
        type: "object",
        properties: { order: { $ref: "#/$defs/Order" } },
        $defs: {
          Duration: { type: "object", properties: { seconds: { type: "integer" } } },
          Order: { type: "object", properties: { timeout: { $ref: "#/$defs/Duration" }, history: { type: "array", items: { $ref: "#/$defs/Duration" } } } },
        },
      })
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await persist(toAssetImportResult(parsed.data));
    expectWhole(r);
    const order = r.byName("Order")!;
    expect(order.fields.create.map((f) => f.decorators?.referencedEntityName)).toEqual(["Duration2", "Duration2"]);
  });

  it("Avro: records Duration and Order, Order.timeout is a Duration and Order.history an array of them", async () => {
    const parsed = parseAvroDocument(
      JSON.stringify({
        type: "record",
        name: "Order",
        fields: [
          { name: "timeout", type: { type: "record", name: "Duration", fields: [{ name: "seconds", type: "long" }] } },
          { name: "history", type: { type: "array", items: "Duration" } },
        ],
      })
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await persist(toAssetImportResult(parsed.data));
    expectWhole(r);
    expect(r.byName("Order")!.fields.create.map((f) => f.decorators?.referencedEntityName)).toEqual(["Duration2", "Duration2"]);
  });

  it("Protobuf: messages Duration and Order, a field and a repeated field of Duration", async () => {
    const parsed = parseProtobufDocument(`syntax = "proto3";\nmessage Duration { int64 seconds = 1; }\nmessage Order { Duration timeout = 1; repeated Duration history = 2; }\n`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await persist(toAssetImportResult(parsed.data));
    expectWhole(r);
    expect(r.byName("Order")!.fields.create.map((f) => f.decorators?.referencedEntityName)).toEqual(["Duration2", "Duration2"]);
  });

  it("TypeSpec: models Duration and Order (through the real compiler), the field TYPE names the model", async () => {
    const source = `namespace Shop;\nmodel Duration { seconds: int32; }\nmodel Order { timeout: Duration; history: Duration[]; }\n`;
    const r = await persist(mapDocumentToImportResult(await compileTypeSpecDocument(source), source));
    expectWhole(r);
    // the importer carries a model-typed field's type as the model's NAME; an array of models is `array` (its element is not carried by it)
    expect(r.byName("Order")!.fields.create.map((f) => f.type)).toEqual(["Duration2", "array"]);
  });

  it("OpenAPI: components.schemas Duration and Order (through the real converter and compiler), the references follow", async () => {
    const openApi = {
      openapi: "3.0.0",
      info: { title: "Shop", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          Duration: { type: "object", properties: { seconds: { type: "integer" } } },
          Order: { type: "object", properties: { timeout: { $ref: "#/components/schemas/Duration" }, history: { type: "array", items: { $ref: "#/components/schemas/Duration" } } } },
        },
      },
    };
    const tsp = await convertOpenAPI3Document(openApi as Parameters<typeof convertOpenAPI3Document>[0]);
    const compiled = await compileTypeSpecDocument(tsp);
    const r = await persist({ ...mapDocumentToImportResult(compiled, tsp), sourceFormat: "openapi" });
    expectWhole(r);
    expect(r.byName("Order")!.fields.create.map((f) => f.type)).toEqual(["Duration2", "array"]);
  }, 60_000);
});
