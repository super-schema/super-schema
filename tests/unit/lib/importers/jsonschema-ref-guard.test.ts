import { describe, expect, it, vi } from "vitest";

// Simulated library that never calls our resolver.
vi.mock("@apidevtools/json-schema-ref-parser", () => ({
  $RefParser: class {
    resolve() {
      return Promise.resolve();
    }
  },
}));

import { resolveJsonSchemaRefs } from "@/lib/importers/jsonschema-ref-resolver";

describe("library-never-called guard", () => {
  it("flags a root with a real external ref when the library never reads it", async () => {
    const r = await resolveJsonSchemaRefs(
      "https://example.com/d/root.json",
      JSON.stringify({ a: { $ref: "./other.json" } }),
      { lookup: async () => ["93.184.216.34"] },
    );
    expect([...r.unreachable.values()].join("|")).toMatch(/never asked the resolver/);
  });

  it("does not flag a root with no external refs", async () => {
    const r = await resolveJsonSchemaRefs(
      "https://example.com/d/root.json",
      JSON.stringify({ a: { $ref: "root.json#/x" }, b: { $ref: "#/y" } }),
      { lookup: async () => ["93.184.216.34"] },
    );
    expect(r.unreachable.size).toBe(0);
  });
});
