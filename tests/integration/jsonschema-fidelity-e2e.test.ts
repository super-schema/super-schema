/**
 * What the JSON Schema importer keeps, end to end (wave 2a of the fidelity review): a document goes through import -> persisted field
 * rows -> generated TypeSpec -> the app's real emitters, and the emitted JSON Schema still says what the document said.
 */
import { describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });
import { compileEntity } from "@/lib/compiler/compiler.service";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { importAndPersist, type Imported } from "../helpers/import-persist";

vi.mock("server-only", () => ({}));

const emitJsonSchema = async (i: Imported) => {
  const result = await emitOfficialTypeSpecTargetFromData(i.entity, i.fields, "json-schema");
  expect(result.errors).toEqual([]);
  return JSON.parse(result.output) as { properties: Record<string, Record<string, unknown>>; required?: string[]; [key: string]: unknown };
};

describe("required + nullable stays required, optional + nullable stays optional (F2b)", () => {
  const SCHEMA = {
    title: "Evt", type: "object", required: ["id", "reqNull", "reqAnyOfNull"],
    properties: {
      id: { type: "string" },
      reqNull: { type: ["string", "null"], maxLength: 8 },
      reqAnyOfNull: { anyOf: [{ type: "integer" }, { type: "null" }] },
      optNull: { type: ["integer", "null"] },
      opt: { type: "string" },
    },
  };
  const flags = (fields: { name: string; nullable: boolean; nullableType?: boolean; requiredNullable?: boolean }[]) =>
    Object.fromEntries(fields.map((f) => [f.name, [f.nullable, f.nullableType ?? false, f.requiredNullable ?? false]]));

  it("the emitted JSON Schema lists the required nullable properties in `required` and types them as a union with null", async () => {
    const schema = await emitJsonSchema(await importAndPersist(SCHEMA));
    expect(schema.required).toEqual(["id", "reqNull", "reqAnyOfNull"]);
    expect(schema.properties.reqNull).toMatchObject({ anyOf: [{ type: "string" }, { type: "null" }], maxLength: 8 });
    expect(schema.properties.reqAnyOfNull).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(schema.properties.optNull).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(schema.properties.opt).toEqual({ type: "string" });
  });

  it("re-importing the emitted JSON Schema gives the same optional / nullable facts, field by field", async () => {
    const i = await importAndPersist(SCHEMA);
    const first = parseJsonSchemaDocument(JSON.stringify(SCHEMA));
    const emitted = await emitOfficialTypeSpecTargetFromData(i.entity, i.fields, "json-schema");
    const again = parseJsonSchemaDocument(emitted.output);
    if (!first.success || !again.success) throw new Error("import failed");
    expect(flags(again.data.entities[0].fields)).toEqual(flags(first.data.entities[0].fields));
    expect(flags(first.data.entities[0].fields)).toEqual({
      id: [false, false, false], reqNull: [true, true, true], reqAnyOfNull: [true, true, true], optNull: [true, true, false], opt: [true, false, false],
    });
  });

  it("the OpenAPI schema lists them in `required` too", async () => {
    const i = await importAndPersist(SCHEMA);
    const result = await emitOfficialTypeSpecTargetFromData(i.entity, i.fields, "openapi3");
    expect(result.errors).toEqual([]);
    expect(result.output).toMatch(/required:\s+- id\s+- reqNull\s+- reqAnyOfNull\s+properties:/);
  });

  it.each(["avro", "protobuf", "java-pojo", "postgresql", "spanner", "bigquery"])("%s still generates it (a null type is a nullable column / field there)", async (target) => {
    const i = await importAndPersist(SCHEMA);
    const result = await emitOfficialTypeSpecTargetFromData(i.entity, i.fields, target);
    expect(result.errors).toEqual([]);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("the DDL keeps the column nullable (the value may be null), the key not", async () => {
    const i = await importAndPersist(SCHEMA);
    const result = await emitOfficialTypeSpecTargetFromData(i.entity, i.fields, "postgresql");
    expect(result.output).toMatch(/req_null (TEXT|VARCHAR\(8\)),/);
    expect(result.output).not.toMatch(/req_null [^,]*NOT NULL/);
  });
});

describe("a property typed with several scalar types (F2a)", () => {
  const SCHEMA = {
    title: "Evt", type: "object", required: ["id", "v"],
    properties: {
      id: { type: "string" },
      v: { type: ["string", "integer"] },
      w: { oneOf: [{ type: "string", format: "date-time" }, { type: "number" }] },
      tags: { type: "array", items: { type: ["string", "integer"] } },
    },
  };

  it("keeps every type through the TypeSpec text", async () => {
    const i = await importAndPersist(SCHEMA);
    const text = generateTypeSpec(compileEntity(i.entity, i.fields), { governance: false });
    expect(text).toMatch(/v: string \| integer;/);
    expect(text).toMatch(/w\?: utcDateTime \| float64;/);
    expect(text).toMatch(/tags\?: \(string \| integer\)\[\];/);
  });

  it("the emitted JSON Schema is anyOf over all the types, not the first one", async () => {
    const schema = await emitJsonSchema(await importAndPersist(SCHEMA));
    expect(schema.properties.v).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] });
    expect(schema.properties.w.anyOf).toEqual([{ type: "string", format: "date-time" }, { type: "number" }]);
    expect(schema.properties.tags).toMatchObject({ type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] } });
    expect(schema.required).toEqual(["id", "v"]);
  });

  it("the emitted JSON Schema re-imports as the same union", async () => {
    const i = await importAndPersist(SCHEMA);
    const result = await emitOfficialTypeSpecTargetFromData(i.entity, i.fields, "json-schema");
    const again = parseJsonSchemaDocument(result.output);
    if (!again.success) throw new Error(again.error.message);
    expect(again.data.entities[0].fields.find((f) => f.name === "v")).toMatchObject({ type: "union", unionMembers: ["string", "integer"] });
  });
});
