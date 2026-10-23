import { describe, expect, it } from "vitest";
import { sanitizeRefs } from "@/lib/importers/jsonschema-ref-resolver";
import { inferSchema } from "@/lib/importers/jsonschema-infer";

describe("a __proto__ key is kept as own data", () => {
  it("sanitizeRefs", () => {
    const input = JSON.parse('{"__proto__":{"type":"string"},"a":1}');
    const out = sanitizeRefs(input, "https://example.com/a.json", () => undefined, { external: 0 }) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(["__proto__", "a"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ type: "string" });
  });

  it("inferSchema", () => {
    const out = inferSchema(JSON.parse('{"__proto__":"x"}')) as { properties: Record<string, unknown> };
    expect(Object.getPrototypeOf(out.properties)).toBe(Object.prototype);
    expect(Object.keys(out.properties)).toEqual(["__proto__"]);
  });
});
