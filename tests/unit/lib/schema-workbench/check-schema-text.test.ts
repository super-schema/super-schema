import { describe, expect, it } from "vitest";
import { checkSchemaText } from "@/lib/schema-workbench/check-schema-text";

const JSON_SCHEMA_ONE = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Customer",
  type: "object",
  properties: { id: { type: "string" }, email: { type: "string" } },
  required: ["id"],
});

const JSON_SCHEMA_MANY = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Order",
  type: "object",
  properties: { id: { type: "string" }, buyer: { $ref: "#/$defs/Buyer" } },
  $defs: {
    Buyer: { type: "object", properties: { name: { type: "string" } } },
    Address: { type: "object", properties: { city: { type: "string" } } },
  },
});

const AVRO = JSON.stringify({
  type: "record",
  name: "Customer",
  fields: [{ name: "id", type: "long" }, { name: "email", type: "string" }],
});

const PROTO = `syntax = "proto3";
message Customer {
  string id = 1;
  string email = 2;
}
`;

const TYPESPEC = `import "@typespec/http";
model Customer {
  id: string;
}
`;

const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  paths: { "/users": {} },
});

describe("checkSchemaText", () => {
  it("is empty for an empty string", async () => {
    expect(await checkSchemaText("")).toEqual({ status: "empty" });
  });

  it("is empty for whitespace only", async () => {
    expect(await checkSchemaText("  \n\t  ")).toEqual({ status: "empty" });
  });

  it("is invalid with a reason when the format cannot be detected", async () => {
    const result = await checkSchemaText("just some words, not a schema");
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("is invalid with a message for malformed JSON", async () => {
    const result = await checkSchemaText('{ "type": "record", "name": "Customer", "fields": [ ');
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.message).toBeTruthy();
  });

  it("summarises a single-entity JSON Schema", async () => {
    const result = await checkSchemaText(JSON_SCHEMA_ONE);
    expect(result).toMatchObject({ status: "valid", format: "json-schema", deferred: false });
    if (result.status !== "valid") return;
    expect(result.summary).toBe("JSON Schema, entity Customer with 2 fields");
  });

  it("summarises a multi-entity JSON Schema with the plural 'entities'", async () => {
    const result = await checkSchemaText(JSON_SCHEMA_MANY);
    expect(result).toMatchObject({ status: "valid", format: "json-schema", deferred: false });
    if (result.status !== "valid") return;
    expect(result.summary).toMatch(/^JSON Schema, \d+ entities/);
  });

  it("recognises an Avro record", async () => {
    const result = await checkSchemaText(AVRO);
    expect(result).toMatchObject({ status: "valid", format: "avro", deferred: false });
    if (result.status !== "valid") return;
    expect(result.summary).toContain("Avro");
    expect(result.summary).toContain("Customer");
  });

  it("recognises a Protobuf message", async () => {
    const result = await checkSchemaText(PROTO);
    expect(result).toMatchObject({ status: "valid", format: "protobuf", deferred: false });
    if (result.status !== "valid") return;
    expect(result.summary).toContain("Protobuf");
    expect(result.summary).toContain("Customer");
  });

  it("recognises TypeSpec without compiling it", async () => {
    const result = await checkSchemaText(TYPESPEC);
    expect(result).toMatchObject({ status: "valid", format: "typespec", deferred: true, warnings: 0 });
    if (result.status !== "valid") return;
    expect(result.summary).toBe("TypeSpec document, compiled when you review");
  });

  it("recognises an OpenAPI document without compiling it", async () => {
    const result = await checkSchemaText(OPENAPI);
    expect(result).toMatchObject({ status: "valid", format: "openapi", deferred: true, warnings: 0 });
    if (result.status !== "valid") return;
    expect(result.summary).toBe("OpenAPI document, compiled when you review");
  });

  it("counts the importer's warnings", async () => {
    // Properties the importer cannot type confidently (`not`, no type, a mixed `oneOf`) each warn on review.
    const result = await checkSchemaText(
      JSON.stringify({
        title: "T",
        type: "object",
        properties: {
          x: { not: { type: "string" } },
          y: {},
          z: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
      })
    );
    expect(result).toMatchObject({ status: "valid", format: "json-schema", warnings: 3 });
  });

  it("reports no warnings for a clean schema and singularises one field", async () => {
    const result = await checkSchemaText(
      JSON.stringify({ title: "T", type: "object", properties: { x: { type: "string", minLength: 2 } } })
    );
    expect(result).toMatchObject({ status: "valid", warnings: 0, summary: "JSON Schema, entity T with 1 field" });
  });
});
