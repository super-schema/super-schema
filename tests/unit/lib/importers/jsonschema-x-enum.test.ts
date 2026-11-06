import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access/principal", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/action-context", () => ({ sanitizeActionError: async (r: unknown) => r }));

import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";
import type { ResolverDeps } from "@/lib/importers/jsonschema-ref-resolver";

const parse = (schema: unknown, sourceName?: string) => parseJsonSchemaDocument(JSON.stringify(schema), undefined, sourceName);
const INTENTS = [
  { value: "LOGIN_SUCCESS", description: "The user logged in." },
  { value: "LOGIN_FAILURE", description: "The login failed." },
];

describe("x-enum: the PayPal enum-with-descriptions extension", () => {
  it("a root with only x-enum is a shared enum that keeps every description", () => {
    const r = parse({ type: "string", title: "login_intents", description: "Intents.", "x-enum": INTENTS });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.scalars).toHaveLength(0);
    expect(r.data.enums).toHaveLength(1);
    expect(r.data.enums[0]).toMatchObject({ values: ["LOGIN_SUCCESS", "LOGIN_FAILURE"], valueDescriptions: { LOGIN_SUCCESS: "The user logged in.", LOGIN_FAILURE: "The login failed." } });
  });

  it("accepts `name` as the symbol key (one file of the risk repo does)", () => {
    const r = parse({ type: "string", title: "ProductLine", "x-enum": [{ name: "CONSUMER", description: "c" }, { name: "BUSINESS", description: "b" }] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.enums[0].values).toEqual(["CONSUMER", "BUSINESS"]);
    expect(r.data.enums[0].valueDescriptions).toEqual({ CONSUMER: "c", BUSINESS: "b" });
  });

  it("a property with only x-enum is an enum field with the descriptions", () => {
    const r = parse({ type: "object", title: "O", properties: { intent: { type: "string", "x-enum": INTENTS } } });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const f = r.data.entities[0].fields[0];
    expect(f).toMatchObject({ type: "enum", enumValues: ["LOGIN_SUCCESS", "LOGIN_FAILURE"], enumValueDescriptions: { LOGIN_FAILURE: "The login failed." } });
  });

  it("an enum next to x-enum keeps the enum's symbols and takes the descriptions", () => {
    const r = parse({ type: "string", title: "E", enum: ["B", "A"], "x-enum": [{ value: "A", description: "a" }, { value: "B", description: "b" }] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.enums[0].values).toEqual(["B", "A"]);
    expect(r.data.enums[0].valueDescriptions).toEqual({ A: "a", B: "b" });
  });

  it("an x-enum $defs entry referenced by a property is a shared enum", () => {
    const r = parse({ type: "object", title: "O", properties: { i: { $ref: "#/$defs/Intent" } }, $defs: { Intent: { type: "string", "x-enum": INTENTS } } });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.enums.map((e) => e.name)).toEqual(["Intent"]);
    expect(r.data.entities[0].fields[0]).toMatchObject({ type: "enum", enumName: "Intent", enumValueDescriptions: { LOGIN_SUCCESS: "The user logged in." } });
  });

  it("is not kept as an unknown extension once it was read", () => {
    const r = parse({ type: "object", title: "O", properties: { intent: { type: "string", "x-enum": INTENTS } } });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0].fields[0].extensions?.["x-enum"]).toBeUndefined();
  });

  it("malformed entries are ignored, never fatal", () => {
    const r = parse({ type: "string", title: "E", "x-enum": [{ value: "A" }, { description: "no symbol" }, "plain", 3] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.enums[0].values).toEqual(["A", "plain"]);
  });
});

describe("a $ref to an x-enum file across files", () => {
  const BASE = "https://example.com/schemas";
  const deps = (files: Record<string, string>): ResolverDeps => ({
    lookup: async () => ["93.184.216.34"],
    fetchHttp: async (url) => { if (url in files) return files[url]!; throw new Error("HTTP 404"); },
    fetchGitFile: async () => { throw new Error("no git"); },
  });
  it("types the field with the enum and its descriptions", async () => {
    const files = {
      [`${BASE}/event.json`]: JSON.stringify({ type: "object", title: "Event", properties: { intent: { $ref: "enums/login_intents.json" } } }),
      [`${BASE}/enums/login_intents.json`]: JSON.stringify({ type: "string", title: "login_intents", "x-enum": INTENTS }),
    };
    const r = await importJsonSchemaFromUrl(`${BASE}/event.json`, deps(files));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.enums).toHaveLength(1);
    expect(r.data.enums[0].valueDescriptions).toMatchObject({ LOGIN_FAILURE: "The login failed." });
    expect(r.data.entities[0].fields[0]).toMatchObject({ type: "enum", enumValueDescriptions: { LOGIN_SUCCESS: "The user logged in." } });
    expect(r.data.warnings.join("\n")).not.toMatch(/no properties|could not be loaded/);
  });
});
