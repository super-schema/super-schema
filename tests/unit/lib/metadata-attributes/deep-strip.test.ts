// R10: the defensive deep strip of `internal` metadata attribute keys from emitted documents.
import { describe, expect, it } from "vitest";
import { deepStripInternal, deepStripInternalFromFile, deepStripInternalFromFiles } from "@/lib/metadata-attributes/deep-strip";

const KEYS = new Set(["x-review-note"]);

describe("deepStripInternal", () => {
  it("removes an internal key at any object depth, inside arrays too", () => {
    const doc = {
      a: { "x-review-note": "top", keep: 1 },
      items: { properties: { b: { items: { "x-review-note": "deep", type: "string" } } } },
      list: [{ "x-review-note": "in array" }, "x-review-note"],
      required: ["x-review-note"],
    };
    const out = deepStripInternal(doc, KEYS);
    expect(JSON.stringify(out)).not.toContain('"x-review-note":');
    expect(out.a).toEqual({ keep: 1 });
    expect(out.items.properties.b.items).toEqual({ type: "string" });
    // values naming the key are left alone
    expect(out.list[1]).toBe("x-review-note");
    expect(out.required).toEqual(["x-review-note"]);
    // the input is not mutated
    expect(doc.a).toHaveProperty("x-review-note");
  });

  it("returns the same reference when nothing matched or there are no keys", () => {
    const doc = { a: { b: [1, { c: 2 }] } };
    expect(deepStripInternal(doc, KEYS)).toBe(doc);
    expect(deepStripInternal(doc, undefined)).toBe(doc);
    expect(deepStripInternal(doc, [])).toBe(doc);
  });

  it("keeps a __proto__ key as an own property", () => {
    const doc = JSON.parse('{"__proto__": {"x": 1}, "x-review-note": 1}');
    const out = deepStripInternal(doc, KEYS) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe("deepStripInternalFromFile", () => {
  it("strips a nested key from a JSON file, keeping its indentation and trailing newline", () => {
    const content = JSON.stringify({ $defs: { A: { properties: { t: { items: { type: "string", "x-review-note": "secret" } } } } } }, null, 2) + "\n";
    const out = deepStripInternalFromFile({ path: "A.json", content }, KEYS);
    expect(out.content).not.toContain("secret");
    expect(out.content).toBe(JSON.stringify({ $defs: { A: { properties: { t: { items: { type: "string" } } } } } }, null, 2) + "\n");
  });

  it("strips a nested key from a YAML file and keeps the rest of it", () => {
    const content = "openapi: 3.0.0\n# a comment\ncomponents:\n  schemas:\n    A:\n      x-review-note: secret\n      type: object\n";
    const out = deepStripInternalFromFile({ path: "openapi.yaml", content }, KEYS);
    expect(out.content).toBe("openapi: 3.0.0\n# a comment\ncomponents:\n  schemas:\n    A:\n      type: object\n");
  });

  it("is byte-identical (the same file) when nothing matched, and leaves non-JSON/YAML files alone", () => {
    const json = { path: "A.json", content: '{\n  "a": 1\n}\n' };
    expect(deepStripInternalFromFile(json, KEYS)).toBe(json);
    const proto = { path: "a.proto", content: 'option (x-review-note) = "s";' };
    expect(deepStripInternalFromFile(proto, KEYS)).toBe(proto);
    const files = [json, proto];
    expect(deepStripInternalFromFiles(files, KEYS)).toBe(files);
  });

  it("finds a key written with a JSON unicode escape", () => {
    const out = deepStripInternalFromFile({ path: "a.avsc", content: '{"type":"record","\\u0078-review-note":"secret"}' }, KEYS);
    expect(out.content).toBe('{"type":"record"}');
  });
});
