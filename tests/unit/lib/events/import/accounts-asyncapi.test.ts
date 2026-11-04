// C2 (docs/superpowers/plans/2026-11-04-jsonschema-standards-support.md): the real Accounts AsyncAPI 2.0 spec (asyncapi.json + the JSON
// schemas it $refs, one of which is missing from the repository) imports through the same pure pipeline the service runs.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAsyncApiParser } from "@/lib/event-specs/validation/parser-core";
import { extractPayloads, mapAsyncApiToEventDocument, parseAsyncApiSource } from "@/lib/events/import";
import { inlineExternalRefs, normalizePath } from "@/lib/events/import/external-refs";
import { upgradeAsyncApiSource } from "@/services/events/asyncapi-upgrade";

const DIR = path.join(process.cwd(), "tests/fixtures/accounts-asyncapi");
const main = readFileSync(path.join(DIR, "asyncapi.json"), "utf8");
function readTree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(path.join(DIR, dir), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, readTree(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".json")) out[rel] = readFileSync(path.join(DIR, dir, entry.name), "utf8");
  }
  return out;
}
const files = { ...readTree("json", "json"), "events.json": readFileSync(path.join(DIR, "events.json"), "utf8") };

describe("normalizePath", () => {
  it("collapses ./ and ../", () => {
    expect(normalizePath("./json/../json/a.json")).toBe("json/a.json");
    expect(normalizePath("../x.json")).toBe("../x.json");
  });
});

describe("inlineExternalRefs", () => {
  it("rewrites nested relative refs, re-bases a file's own #/ refs and reports what is missing", () => {
    const root = { a: { $ref: "dir/one.json#/definitions/d" }, b: { $ref: "missing.json" }, c: { $ref: "https://example.com/x.json" } };
    const result = inlineExternalRefs(root, {
      "dir/one.json": JSON.stringify({ definitions: { d: { $ref: "#/definitions/e" }, e: { type: "string" } }, p: { $ref: "../two.json" } }),
      "two.json": JSON.stringify({ type: "integer" }),
    });
    const schemas = (result.document.components as { schemas: Record<string, any> }).schemas;
    const oneKey = Object.keys(schemas).find((k) => schemas[k].definitions);
    expect(oneKey).toBeDefined();
    expect((result.document.a as any).$ref).toBe(`#/components/schemas/${oneKey}/definitions/d`);
    expect(schemas[oneKey!].definitions.d.$ref).toBe(`#/components/schemas/${oneKey}/definitions/e`);
    expect(schemas[oneKey!].p.$ref).toMatch(/^#\/components\/schemas\//);
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/missing\.json[\s\S]*URL/);
    expect(result.document.b).toEqual({ description: "Unresolved reference: missing.json" });
  });

  it("does not treat a $ref string inside enum/default as a reference and survives a file that refers to itself", () => {
    const result = inlineExternalRefs({ s: { $ref: "self.json" } }, { "self.json": JSON.stringify({ type: "object", enum: [{ $ref: "x.json" }], properties: { me: { $ref: "self.json" } } }) });
    expect(result.warnings).toEqual([]);
    const schemas = (result.document.components as { schemas: Record<string, any> }).schemas;
    const key = Object.keys(schemas)[0];
    expect(schemas[key].enum[0]).toEqual({ $ref: "x.json" });
    expect(schemas[key].properties.me.$ref).toBe(`#/components/schemas/${key}`);
  });
});

describe("Accounts AsyncAPI 2.0 spec", () => {
  it("is rejected as is (2.x) but upgrades to a document the reader and the AsyncAPI parser accept", async () => {
    expect(parseAsyncApiSource(main).success).toBe(false);
    const upgraded = upgradeAsyncApiSource(main, files);
    expect(upgraded.success).toBe(true);
    if (!upgraded.success) return;
    const parsed = parseAsyncApiSource(upgraded.data.text);
    expect(parsed.success).toBe(true);
    const { diagnostics } = await createAsyncApiParser().parse(upgraded.data.text);
    const errors = diagnostics.filter((d) => d.severity === 0).map((d) => `${d.code}: ${d.message} at /${(d.path ?? []).join("/")}`);
    expect(errors).toEqual([]);
  }, 60_000);

  it("imports all three channels as events through extract + map, with a warning for every thing it cannot carry", () => {
    const upgraded = upgradeAsyncApiSource(main, files);
    if (!upgraded.success) throw new Error(upgraded.error.message);
    const raw = parseAsyncApiSource(upgraded.data.text);
    if (!raw.success) throw new Error(raw.error.message);
    const extracted = extractPayloads(raw.data);
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const payloads = extracted.data.filter((p) => p.role === "payload");
    expect(payloads).toHaveLength(3);
    // login_activity_event.json is not in the repository: that payload degrades, it does not fail the import
    expect(upgraded.data.warnings.some((w) => /login_activity_event\.json/.test(w.message))).toBe(true);
    const pins = new Map(extracted.data.map((p) => [`${p.messageKey}:${p.role}`, { entityId: "placeholder", entityVersionId: null }]));
    const mapped = mapAsyncApiToEventDocument(raw.data, { payloadPins: pins, builtInTraitIds: {} });
    expect(mapped.success).toBe(true);
    if (!mapped.success) return;
    expect(mapped.data.document.channels).toHaveLength(3);
    expect(mapped.data.document.servers).toHaveLength(1);
    expect(mapped.data.document.operations).toHaveLength(3);
    const all = [...upgraded.data.warnings, ...mapped.data.warnings];
    expect(all.some((w) => w.code === "UNSUPPORTED_EXTENSION" && /x-(visibility|slo)/.test(w.message))).toBe(true);
    expect(extracted.data.map((p) => [p.messageKey, p.role, p.format])).toEqual([
      ["login_activity_event", "payload", "json-schema"], ["login_activity_event", "headers", "json-schema"],
      ["account-activation_event", "payload", "json-schema"], ["account_closed_event", "payload", "json-schema"],
    ]);
    // the CloudEvents and the PayPal OML schemaFormats are not unsupported placeholders: the schemas are ordinary JSON Schema objects
    expect(extracted.data.filter((p) => p.assumedFormat !== undefined).map((p) => p.messageKey)).toEqual(["account_closed_event"]);
    expect(all.some((w) => w.code === "KEY_ADJUSTED" || w.code === "UNSUPPORTED_PAYLOAD_FORMAT")).toBe(false);
  });

  it("without sibling files every reference degrades to a warning and the import still maps", () => {
    const upgraded = upgradeAsyncApiSource(main);
    if (!upgraded.success) throw new Error(upgraded.error.message);
    expect(upgraded.data.warnings.filter((w) => w.code === "DROPPED_CONSTRUCT").length).toBeGreaterThanOrEqual(4);
    const raw = parseAsyncApiSource(upgraded.data.text);
    expect(raw.success).toBe(true);
  });
});
