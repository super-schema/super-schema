import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseProtobufDocument } from "@/lib/importers/protobuf.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload, parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";
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
