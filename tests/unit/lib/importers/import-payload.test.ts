import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseProtobufDocument } from "@/lib/importers/protobuf.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload, decimalFacts, parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";
import { mapDocumentToImportResult } from "@/lib/importers/typespec.importer";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";

function protoResult() {
  const r = parseProtobufDocument(
    readFileSync(path.resolve(process.cwd(), "tests/fixtures/importers/order.proto"), "utf8")
  );
  if (!r.success) throw new Error(r.error.message);
  return toAssetImportResult(r.data);
}

const NO_SELECTION = {
  domainId: "domain-1",
  selectedModels: [],
  selectedEntities: [],
  selectedEnums: [],
  selectedScalars: [],
  selectedUnions: [],
  selectedServices: [],
  selectedDecorators: [],
};

describe("buildImportAssetsPayload", () => {
  it("maps the selected indices to models, entities, enums", () => {
    const result = protoResult();
    const payload = buildImportAssetsPayload(result, {
      ...NO_SELECTION,
      selectedModels: [0, 1],
      selectedEntities: [0, 1],
      selectedEnums: [1],
    });
    expect(payload.namespace).toBe("shop.orders.v1");
    expect(payload.models.map((m) => m.name)).toEqual(["Order", "Order_LineItem"]);
    expect(payload.entities.map((e) => e.name)).toEqual(["Order", "Order_LineItem"]);
    expect(payload.sharedEnums).toEqual([result.sharedEnums[1]]);
    expect(payload.customScalars).toEqual([]);
    expect(payload.services).toEqual([]);
  });

  it("builds field inputs with decorators that keep references, enums and oneof groups", () => {
    const payload = buildImportAssetsPayload(protoResult(), {
      ...NO_SELECTION,
      selectedModels: [0],
      selectedEntities: [0],
    });
    const fields = Object.fromEntries(payload.entities[0].fields.map((f) => [f.name, f]));
    expect(fields.items.decorators).toMatchObject({
      arrayElementType: "reference",
      referencedEntityName: "Order_LineItem",
    });
    expect(fields.status.decorators).toMatchObject({ enumName: "OrderStatus" });
    expect(fields.card.decorators).toMatchObject({ governance: { protobufOneofGroup: "payment" } });
  });

  it("carries the source format and protobuf field numbers (Story 15.8)", () => {
    const payload = buildImportAssetsPayload(protoResult(), {
      ...NO_SELECTION,
      selectedEntities: [0],
    });
    expect(payload.sourceFormat).toBe("protobuf");
    const card = payload.entities[0].fields.find((f) => f.name === "card");
    expect(card?.fieldNumber).toBe(8);
  });

  it("defaults the source format to typespec for results that do not name one", () => {
    const payload = buildImportAssetsPayload({ ...protoResult(), sourceFormat: undefined }, NO_SELECTION);
    expect(payload.sourceFormat).toBe("typespec");
  });

  it("carries model tags to the selected entities only, with classification on the fields (Story 16.6)", () => {
    const source = [
      'import "@superschema/typespec-enterprise";',
      'import "@typespec/openapi";',
      "",
      '@TypeSpec.OpenAPI.extension("x-tags", #["sales", "core"])',
      "model Customer {",
      "  @Enterprise.dataClassification(Enterprise.DataClassification.Confidential)",
      "  note?: string;",
      "}",
      "",
    ].join("\n");
    const result = mapDocumentToImportResult(parseTypeSpecDocument(source), source);
    const payload = buildImportAssetsPayload(result, { ...NO_SELECTION, selectedModels: [0], selectedEntities: [0] });

    expect(payload.entities[0].tags).toEqual(["sales", "core"]);
    expect(payload.entities[0].fields[0].classification).toBe("SENSITIVE");
    expect(payload.models[0]).not.toHaveProperty("tags");
    // A model without tags adds no key.
    const untagged = buildImportAssetsPayload(protoResult(), { ...NO_SELECTION, selectedEntities: [0] });
    expect(untagged.entities[0]).not.toHaveProperty("tags");
  });
});

describe("parsedFieldToCreateFieldInput", () => {
  it("maps a parsed field to the create input shape", () => {
    const input = parsedFieldToCreateFieldInput({
      name: "email",
      type: "string",
      nullable: false,
      confidence: "high",
      originalType: "string",
      description: "Contact",
      classification: "PII",
    });
    expect(input).toEqual({
      name: "email",
      type: "string",
      nullable: false,
      isKey: false,
      description: "Contact",
      classification: "PII",
      precision: null,
      scale: null,
      decorators: { semantics: { description: "Contact" }, classification: { level: "PII" } },
    });
  });
});

describe("the precision and scale of an imported decimal", () => {
  const decimal = { name: "total", type: "decimal", nullable: true, confidence: "high" as const, originalType: "NUMERIC(12, 2)", precision: 12, scale: 2 };

  it("travel into the create input of an imported field", () => {
    expect(parsedFieldToCreateFieldInput(decimal)).toMatchObject({ type: "decimal", precision: 12, scale: 2 });
  });

  it("are null for a field that declared none", () => {
    expect(parsedFieldToCreateFieldInput({ ...decimal, precision: undefined, scale: undefined })).toMatchObject({ precision: null, scale: null });
  });

  it("travel through the multi-asset payload, for a model and an entity alike", () => {
    const result = {
      models: [{ name: "Ledger", fields: [decimal], referencedModelNames: [], referencedByModelNames: [], recommendedAsEntity: true }],
      sharedEnums: [],
      customScalars: [],
      unions: [],
      services: [],
      decoratorDefinitions: [],
      warnings: [],
    } as unknown as Parameters<typeof buildImportAssetsPayload>[0];
    const payload = buildImportAssetsPayload(result, { ...NO_SELECTION, selectedModels: [0], selectedEntities: [0] });
    expect(payload.models[0].fields[0]).toMatchObject({ precision: 12, scale: 2 });
    expect(payload.entities[0].fields[0]).toMatchObject({ precision: 12, scale: 2 });
  });

  describe("decimalFacts (what the single-entity review writes)", () => {
    it("keeps them while the type is still the imported one", () => {
      expect(decimalFacts(decimal, "decimal")).toEqual({ precision: 12, scale: 2 });
    });

    it("drops them when the reviewer changed the type (they belong to a decimal)", () => {
      expect(decimalFacts(decimal, "string")).toEqual({ precision: null, scale: null });
    });

    it("is null for a field the importer did not parse (a template, a field added by hand)", () => {
      expect(decimalFacts(undefined, "decimal")).toEqual({ precision: null, scale: null });
    });
  });
});

describe("text that PostgreSQL cannot store never reaches a create (every importer shares ParsedField.description)", () => {
  const field = { name: "note", type: "string", nullable: true, confidence: "high" as const, originalType: "string" };

  it("a NUL is dropped and a lone surrogate replaced in a field's description", () => {
    expect(parsedFieldToCreateFieldInput({ ...field, description: "a\u0000b\ud800c" }).description).toBe("ab\uFFFDc");
    expect(parsedFieldToCreateFieldInput({ ...field, description: "plain 😀" }).description).toBe("plain 😀");
    expect(parsedFieldToCreateFieldInput({ ...field }).description).toBe("");
  });

  it("... and in the description of every model and entity of a multi-asset payload", () => {
    const result = {
      models: [{ name: "Ledger", description: "the\u0000 ledger", fields: [{ ...field, description: "x\u0000y" }], referencedModelNames: [], referencedByModelNames: [], recommendedAsEntity: true }],
      sharedEnums: [],
      customScalars: [],
      unions: [],
      services: [],
      decoratorDefinitions: [],
      warnings: [],
    } as unknown as Parameters<typeof buildImportAssetsPayload>[0];
    const payload = buildImportAssetsPayload(result, { ...NO_SELECTION, selectedModels: [0], selectedEntities: [0] });
    expect(payload.models[0].description).toBe("the ledger");
    expect(payload.entities[0].description).toBe("the ledger");
    expect(payload.models[0].fields[0].description).toBe("xy");
    expect(payload.entities[0].fields[0].description).toBe("xy");
  });
});
