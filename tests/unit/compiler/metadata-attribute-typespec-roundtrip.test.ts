/**
 * Attribute values are ordinary vendor extensions. Canonical source (`generateTypeSpec`) must re-import through the TypeSpec
 * importer with every JSON value intact, on fields (decorators.typespec.extensions.openapi) and models (metadata.custom.extensions).
 */
import { describe, it, expect, vi } from "vitest";
import { compileEntity, type PrismaEntityInput, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import { mapDocumentToImportResult } from "@/lib/importers/typespec.importer";
import { buildImportAssetsPayload, parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";

vi.mock("server-only", () => ({}));

const SEL = {
  domainId: "d", selectedModels: [0], selectedEntities: [0], selectedEnums: [], selectedScalars: [],
  selectedUnions: [], selectedServices: [], selectedDecorators: [],
};

const entity = (extensions?: Record<string, unknown>): PrismaEntityInput => ({
  id: "e", name: "Payment", description: "", status: "DRAFT", version: 1, domainId: "d",
  metadata: extensions ? { custom: { extensions } } : {},
  domain: { id: "d", name: "Sales", slug: "sales" },
});
const field = (name: string, openapi?: Record<string, unknown>): PrismaFieldInput => ({
  id: name, name, type: "string", nullable: false, isKey: false, fieldNumber: null, precision: null, scale: null,
  aliases: [], description: "", decorators: openapi ? { typespec: { extensions: { openapi } } } : {},
  classification: null, sortOrder: 0,
});

const FIELD_VALUES: Record<string, unknown> = {
  "x-securityClassification": { data_class: "class2", data_category: "ConsumerPersonal" },
  "x-supportedCountries": ["US", "GB"],
  "x-slo": { response_time_95th_percentile: 200, error_rate: 0.001 },
  "x-flag": true,
  "x-tricky": 'say "hi" ${x} \\ end',
};

function roundTrip(model: ReturnType<typeof compileEntity>) {
  const src = generateTypeSpec(model);
  const doc = parseTypeSpecDocument(src);
  const result = mapDocumentToImportResult(doc, src);
  const payload = buildImportAssetsPayload(result, SEL);
  return { src, doc, result, payload };
}

describe("metadata attribute values round trip through canonical TypeSpec", () => {
  it("field values survive generate -> parse -> import payload", () => {
    const { src, result } = roundTrip(compileEntity(entity(), [field("amount", FIELD_VALUES)]));
    expect(src).toContain(
      '@TypeSpec.JsonSchema.extension("x-securityClassification", #{data_class: "class2", data_category: "ConsumerPersonal"})'
    );
    const parsed = result.models[0].fields[0];
    expect(parsed.extensions).toEqual(FIELD_VALUES);
    const input = parsedFieldToCreateFieldInput(parsed);
    expect((input.decorators as { typespec: { extensions: { openapi: unknown } } }).typespec.extensions.openapi).toEqual(FIELD_VALUES);
  });

  it("entity values survive generate -> parse -> import payload", () => {
    const ext = { "x-owner-team": "payments", ...FIELD_VALUES };
    const { result, payload } = roundTrip(compileEntity(entity(ext), [field("amount")]));
    expect(result.models[0].extensions).toEqual(ext);
    expect(payload.entities[0].extensions).toEqual(ext);
  });

  it("emits the JsonSchema/OpenAPI pair once per key and imports one entry per key", () => {
    const { src, doc } = roundTrip(compileEntity(entity({ "x-owner-team": "payments" }), [field("a", { "x-flag": true })]));
    expect(src.match(/extension\("x-owner-team"/g)).toHaveLength(2);
    expect(doc.models[0].extensions).toEqual({ "x-owner-team": "payments" });
    expect(doc.models[0].fields[0].decorators.extensions).toEqual({ "x-flag": true });
  });

  it("a model with no extensions emits none and imports none", () => {
    const { src, result } = roundTrip(compileEntity(entity(), [field("a")]));
    expect(src).not.toContain("extension(");
    expect(src).not.toContain("@typespec/json-schema");
    expect(result.models[0].extensions).toBeUndefined();
  });

  it("does not write the stored-only $id / $schema keys", () => {
    const { src } = roundTrip(compileEntity(entity({ $id: "urn:x", $schema: "s", "x-a": 1 }), [field("a")]));
    expect(src).not.toContain('"$id"');
    expect(src).not.toContain('"$schema"');
    expect(src).toContain('"x-a"');
  });

  it("the compiler (AST) import path reads the same values on fields and models", async () => {
    const ext = { "x-owner-team": "payments", "x-supportedCountries": ["US", "GB"] };
    const src = generateTypeSpec(compileEntity(entity(ext), [field("amount", FIELD_VALUES)]));
    const { compileTypeSpecDocument } = await import("@/lib/compiler/typespec-compiler");
    const doc = await compileTypeSpecDocument(src);
    expect(doc.models[0].extensions).toEqual(ext);
    expect(doc.models[0].fields[0].decorators.extensions).toEqual(FIELD_VALUES);
  });
});
