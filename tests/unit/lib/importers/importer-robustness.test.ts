/**
 * Importer robustness (final review C, minor): a leading BOM is ignored, malformed field entries and absurd
 * nesting come back as a Result (an error, or a low-confidence import) — never a thrown exception.
 */
import { describe, it, expect } from "vitest";
import { parseAvroDocument, parseAvroSchema, MAX_AVRO_NESTING } from "@/lib/importers/avro.importer";
import { parseJsonSchemaDocument, parseJsonSchema, MAX_SCHEMA_NESTING } from "@/lib/importers/jsonschema.importer";

const BOM = "﻿";

const AVRO = JSON.stringify({ type: "record", name: "User", fields: [{ name: "id", type: "string" }] });
const JSON_SCHEMA = JSON.stringify({ title: "User", type: "object", properties: { id: { type: "string" } } });

describe("byte-order mark", () => {
  it("Avro: a BOM-prefixed schema imports like the plain one", () => {
    const plain = parseAvroDocument(AVRO);
    const bom = parseAvroDocument(BOM + AVRO);
    expect(plain.success).toBe(true);
    expect(bom.success).toBe(true);
    if (!bom.success || !plain.success) return;
    expect(bom.data.entities.map((e) => e.name)).toEqual(["User"]);
    // The stored original content is the document, not the marker.
    expect(bom.data.entities[0].originalContent.charCodeAt(0)).not.toBe(0xfeff);
    expect(parseAvroSchema(BOM + AVRO).success).toBe(true);
  });

  it("JSON Schema (JSON): a BOM-prefixed schema imports", () => {
    const r = parseJsonSchemaDocument(BOM + JSON_SCHEMA);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0].originalContent.charCodeAt(0)).not.toBe(0xfeff);
    expect(parseJsonSchema(BOM + JSON_SCHEMA).success).toBe(true);
  });

  it("JSON Schema (YAML): a BOM-prefixed schema imports", () => {
    const r = parseJsonSchemaDocument(`${BOM}title: User\ntype: object\nproperties:\n  id:\n    type: string\n`);
    expect(r.success).toBe(true);
  });
});

describe("Avro malformed input", () => {
  it('"fields": [null] is skipped with a warning, not a TypeError', () => {
    const r = parseAvroDocument('{"type":"record","name":"R","fields":[null,{"name":"ok","type":"string"},"x",{"type":"string"},[1]]}');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0].fields.map((f) => f.name)).toEqual(["ok"]);
    expect(r.data.warnings.filter((w) => w.includes("is not a field definition"))).toHaveLength(4);
  });

  it("a record whose only field entry is null imports as an empty record", () => {
    const r = parseAvroDocument('{"type":"record","name":"R","fields":[null]}');
    expect(r.success).toBe(true);
  });

  it("very deep nesting (5000 levels) imports with a warning instead of overflowing the stack", () => {
    const depth = 5000;
    const deep =
      '{"type":"record","name":"R","fields":[{"name":"f","type":' +
      '{"type":"array","items":'.repeat(depth) +
      '"string"' +
      "}".repeat(depth) +
      "}]}";
    const r = parseAvroDocument(deep);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.warnings.some((w) => w.includes(`nested more than ${MAX_AVRO_NESTING} levels`))).toBe(true);
  });

  it("nesting inside the limit is untouched", () => {
    const depth = 50;
    const nested =
      '{"type":"record","name":"R","fields":[{"name":"f","type":' +
      '{"type":"array","items":'.repeat(depth) +
      '"string"' +
      "}".repeat(depth) +
      "}]}";
    const r = parseAvroDocument(nested);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.warnings).toEqual([]);
  });

  it("never throws on non-string input", () => {
    for (const bad of [undefined, null, 123, {}] as unknown as string[]) {
      const r = parseAvroDocument(bad);
      expect(r.success).toBe(false);
    }
  });
});

describe("JSON Schema deep / malformed input", () => {
  it("deeply nested combinators (5000 levels) import at low confidence instead of overflowing", () => {
    const depth = 5000;
    const doc =
      '{"title":"T","type":"object","properties":{"p":' + '{"oneOf":['.repeat(depth) + '{"type":"string"}' + "]}".repeat(depth) + "}}";
    const r = parseJsonSchemaDocument(doc);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0].fields[0].confidence).toBe("low");
    expect(MAX_SCHEMA_NESTING).toBe(200);
  });

  it("50000-deep combinators return a Result (error or low-confidence import), never a throw", () => {
    const depth = 50_000;
    const doc =
      '{"title":"T","type":"object","properties":{"p":' + '{"anyOf":['.repeat(depth) + '{"type":"string"}' + "]}".repeat(depth) + "}}";
    expect(() => parseJsonSchemaDocument(doc)).not.toThrow();
    const r = parseJsonSchemaDocument(doc);
    expect(typeof r.success).toBe("boolean");
  });

  it("null / boolean combinator members do not crash the importer", () => {
    const r = parseJsonSchemaDocument(
      JSON.stringify({ title: "T", type: "object", properties: { a: { oneOf: [null, true] }, b: { anyOf: [null, { type: "integer" }] } } })
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const byName = Object.fromEntries(r.data.entities[0].fields.map((f) => [f.name, f]));
    expect(byName.b.type).toBe("integer");
  });

  it("never throws on non-string input", () => {
    for (const bad of [undefined, null, 123] as unknown as string[]) {
      expect(parseJsonSchemaDocument(bad).success).toBe(false);
    }
  });
});
