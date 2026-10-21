import { describe, expect, it } from "vitest";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import { mapDocumentToImportResult } from "@/lib/importers/typespec.importer";
import { buildImportAssetsPayload, parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import type { ParsedEntity } from "@/lib/importers/types";

const SEL = {
  domainId: "d", selectedModels: [0], selectedEntities: [0], selectedEnums: [], selectedScalars: [],
  selectedUnions: [], selectedServices: [], selectedDecorators: [],
};

const entity: ParsedEntity = {
  name: "Child",
  extends: "Base",
  sourceFormat: "json-schema",
  originalContent: "",
  extensions: { "x-links": [{ rel: "self" }] },
  fields: [{ name: "a", type: "string", nullable: false, confidence: "high", originalType: "string", extensions: { "x-v": { k: 1 } } }],
};

const asResult = (e: ParsedEntity) =>
  toAssetImportResult({ entities: [e], enums: [], scalars: [], warnings: [], sourceFormat: "jsonschema" } as never);

describe("extensions through the import payload", () => {
  it("toAssetImportResult keeps entity extensions and extends", () => {
    const r = asResult(entity);
    expect(r.models[0].extensions).toEqual(entity.extensions);
    expect(r.models[0].extends).toBe("Base");
  });

  it("buildImportAssetsPayload carries extensions and extends on models and entities", () => {
    const p = buildImportAssetsPayload(asResult(entity), SEL);
    expect(p.models[0].extensions).toEqual(entity.extensions);
    expect(p.entities[0].extensions).toEqual(entity.extensions);
    expect(p.entities[0].extends).toBe("Base");
  });

  it("omits extensions when there are none", () => {
    const p = buildImportAssetsPayload(asResult({ ...entity, extensions: undefined }), SEL);
    expect("extensions" in p.entities[0]).toBe(false);
    expect("extensions" in p.models[0]).toBe(false);
  });

  it("field extensions land in decorators.typespec.extensions.openapi", () => {
    const input = parsedFieldToCreateFieldInput(entity.fields[0]);
    expect((input.decorators as { typespec: { extensions: { openapi: unknown } } }).typespec.extensions.openapi).toEqual({ "x-v": { k: 1 } });
  });

  it("mapDocumentToImportResult (compile-path doc) carries model extensions into the payload", () => {
    const doc = parseTypeSpecDocument("model A {\n  id: string;\n}\n");
    doc.models[0].extensions = { "x-links": [1, 2] };
    const r = mapDocumentToImportResult(doc, "");
    expect(r.models[0].extensions).toEqual({ "x-links": [1, 2] });
    const p = buildImportAssetsPayload(r, SEL);
    expect(p.entities[0].extensions).toEqual({ "x-links": [1, 2] });
  });
});
