/**
 * The yaml parser alone costs ~2.8 s and ~1 GB for one 1.8 MB document, before any guard runs. YAML documents are therefore capped
 * (512 KiB by default, `SCHEMA_IMPORT_MAX_YAML_BYTES`) BEFORE they are parsed, at the one place every YAML parse goes through; JSON is
 * not YAML for this purpose (it is read with JSON.parse, and keeps its own, larger cap).
 */
import { describe, it, expect, afterEach } from "vitest";
import { parseYamlBounded, yamlMaxBytes, YAML_DEFAULT_MAX_BYTES, YAML_MAX_BYTES_ENV } from "@/lib/importers/safe-yaml";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { detectFormat as detectImportFormat } from "@/lib/importers/format-detector";

const MESSAGE = "YAML documents are limited to 512 KiB; convert to JSON for larger schemas";

/** A valid YAML JSON Schema of about `bytes` bytes. */
function yamlSchema(bytes: number): string {
  const lines = ["title: Big", "type: object", "properties:"];
  let size = lines.join("\n").length;
  for (let i = 0; size < bytes; i++) {
    const line = `  field_${i}: { type: string, description: "${"x".repeat(40)}" }`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

afterEach(() => {
  delete process.env[YAML_MAX_BYTES_ENV];
});

describe("the YAML size cap", () => {
  it("is 512 KiB by default", () => {
    expect(YAML_DEFAULT_MAX_BYTES).toBe(512 * 1024);
    expect(yamlMaxBytes({})).toBe(512 * 1024);
  });

  it("refuses a 600 KB YAML document with the message, before parsing it", () => {
    const text = yamlSchema(600 * 1024);
    expect(text.length).toBeGreaterThan(600 * 1024);
    const started = performance.now();
    const r = parseYamlBounded(text);
    const ms = performance.now() - started;
    expect(r).toEqual({ ok: false, kind: "size", message: MESSAGE });
    expect(ms).toBeLessThan(50);
  });

  it("accepts a document under it", () => {
    const r = parseYamlBounded(yamlSchema(100 * 1024));
    expect(r.ok).toBe(true);
  });

  it("counts bytes, not characters", () => {
    const wide = `a: "${"é".repeat(300_000)}"`; // 300k characters, 600k bytes
    expect(wide.length).toBeLessThan(512 * 1024);
    expect(parseYamlBounded(wide)).toMatchObject({ ok: false, kind: "size" });
    expect(parseYamlBounded(`a: "${"é".repeat(100_000)}"`).ok).toBe(true);
  });

  it("does not apply to JSON: a 600 KB JSON document is read by JSON.parse", () => {
    const json = JSON.stringify({ title: "Big", type: "object", properties: Object.fromEntries(Array.from({ length: 8000 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(40) }])) });
    expect(json.length).toBeGreaterThan(600 * 1024);
    const r = parseYamlBounded(json);
    expect(r.ok).toBe(true);
  });

  it("can be changed with SCHEMA_IMPORT_MAX_YAML_BYTES (a positive number; anything else is the default)", () => {
    expect(yamlMaxBytes({ [YAML_MAX_BYTES_ENV]: "2048" })).toBe(2048);
    for (const bad of ["", "0", "-5", "abc", "1e400", "12.5x"]) expect(yamlMaxBytes({ [YAML_MAX_BYTES_ENV]: bad }), bad).toBe(512 * 1024);
    process.env[YAML_MAX_BYTES_ENV] = "2000";
    expect(parseYamlBounded(yamlSchema(3000))).toMatchObject({ ok: false, kind: "size" });
    expect(parseYamlBounded("a: 1").ok).toBe(true);
  });
});

describe("every YAML parse goes through it", () => {
  const big = yamlSchema(600 * 1024);

  it("the JSON Schema importer reports the cap (not a parse error, and quickly)", () => {
    const started = performance.now();
    const r = parseJsonSchemaDocument(big);
    expect(performance.now() - started).toBeLessThan(500);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.message).toBe(MESSAGE);
    expect(r.error.suggestedFix).toMatch(/JSON/);
    expect(r.error.suggestedFix).not.toMatch(/alias/i);
  });

  it("the importer still reads a YAML schema under the cap", () => {
    expect(parseJsonSchemaDocument(yamlSchema(50 * 1024)).success).toBe(true);
  });

  it("the format detector does not parse an over-large YAML (it falls back to its other checks)", () => {
    const started = performance.now();
    expect(() => detectImportFormat(big)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
