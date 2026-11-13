/**
 * Import -> canonical TypeSpec -> JSON Schema emit (real emitter): an imported `x-securityClassification` block comes back out
 * unchanged, and the imported `class2` level lands on the PII classification.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const KEY = "x-securityClassification";
const BLOCK = { data_class: "class2", data_category: "ConsumerPersonal" };

let classification: string | null | undefined;
let source = "";
let emitted: { properties: Record<string, Record<string, unknown>> };

beforeAll(async () => {
  const parsed = parseJsonSchemaDocument(
    JSON.stringify({ title: "Customer", type: "object", properties: { email: { type: "string", [KEY]: BLOCK } }, required: ["email"] }),
  );
  if (!parsed.success) throw new Error("import failed");
  const result = toAssetImportResult(parsed.data);
  const payload = buildImportAssetsPayload(result, {
    domainId: "d", selectedModels: [], selectedEntities: [0], selectedEnums: [], selectedScalars: [],
    selectedUnions: [], selectedServices: [], selectedDecorators: [],
  });
  const imported = payload.entities[0].fields[0];
  classification = imported.classification;

  const entity: PrismaEntityInput = {
    id: "ent-1", name: "Customer", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: null,
    domain: { id: "d", name: "Sales", slug: "sales" },
  };
  const fields = [
    {
      id: "f0", name: imported.name, type: imported.type, precision: null, scale: null, nullable: imported.nullable, isKey: false,
      fieldNumber: null, description: imported.description ?? "", classification: imported.classification, aliases: [],
      decorators: imported.decorators, sortOrder: 0,
    },
  ] as PrismaFieldInput[];
  source = generateTypeSpec(compileEntity(entity, fields));
  const out = await emitOfficialTypeSpecTargetFromData(entity, fields, "json-schema");
  expect(out.validationStatus).not.toBe("INVALID");
  const parts = out.output.split(/^===== (.+) =====$/m);
  const body = parts.length === 1 ? out.output : parts[parts.findIndex((p) => p.endsWith("Customer.json")) + 1];
  emitted = JSON.parse(body);
});

describe("import -> canonical TypeSpec -> JSON Schema", () => {
  it("classifies the field as PII", () => {
    expect(classification).toBe("PII");
  });

  it("the canonical TypeSpec carries the block", () => {
    expect(source).toContain(KEY);
    expect(source).toContain("ConsumerPersonal");
  });

  it("the emitted property returns the imported block unchanged", () => {
    expect(emitted.properties.email[KEY]).toEqual(BLOCK);
  });
});
