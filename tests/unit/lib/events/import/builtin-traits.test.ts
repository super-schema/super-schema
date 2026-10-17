// tests/unit/lib/events/import/builtin-traits.test.ts
// WP-I1: a message trait whose headers look like CloudEvents or W3C Trace Context is recognised as the built-in library trait.
import { describe, expect, it } from "vitest";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";
import { builtInKindOfMarker, detectBuiltInTrait } from "@/lib/events/import/builtin-traits";

const CE_REQUIRED = ["specversion", "id", "source", "type"];
/** A trait with a headers schema of `names`; `required` defaults to all of them, `schemas` overrides single property schemas. */
const headers = (names: string[], required: string[] = names, schemas: Record<string, object> = {}) => ({
  headers: { type: "object", required, properties: Object.fromEntries(names.map((n) => [n, schemas[n] ?? { type: "string" }])) },
});
const bundled = (name: string) => structuredClone(BUNDLED_TRAITS.find((t) => t.name === name)?.spec) as Record<string, unknown>;

describe("detectBuiltInTrait: CloudEvents", () => {
  it("recognises the built-in definition itself (the names come from BUNDLED_TRAITS, not from a copy)", () => {
    expect(detectBuiltInTrait(bundled("CloudEvents"))).toEqual({ kind: "cloudEvents", name: "CloudEvents" });
  });

  it("needs all four required context attributes: specversion, id, source, type", () => {
    expect(detectBuiltInTrait(headers(CE_REQUIRED))?.kind).toBe("cloudEvents");
    for (const missing of CE_REQUIRED) {
      const names = CE_REQUIRED.filter((n) => n !== missing);
      expect(detectBuiltInTrait(headers(names)), `without ${missing}`).toBeNull();
    }
  });

  it("allows the optional attributes of the built-in and nothing else", () => {
    const optional = ["subject", "time", "datacontenttype", "dataschema"];
    expect(detectBuiltInTrait(headers([...CE_REQUIRED, ...optional], CE_REQUIRED))?.kind).toBe("cloudEvents");
    expect(detectBuiltInTrait(headers([...CE_REQUIRED, "tenantid"], CE_REQUIRED))).toBeNull();
  });

  it("ignores the trait's documentation and other keys: only the headers decide", () => {
    const spec = { summary: "Envelope", description: "d", tags: [{ name: "x" }], ...headers(CE_REQUIRED) };
    expect(detectBuiltInTrait(spec)?.kind).toBe("cloudEvents");
  });

  it("the trait must REQUIRE every attribute the built-in requires: a weaker (or missing) required list is the user's own trait", () => {
    expect(detectBuiltInTrait(headers(CE_REQUIRED, ["specversion", "id", "source"]))).toBeNull();
    expect(detectBuiltInTrait(headers(CE_REQUIRED, []))).toBeNull();
    const noRequired = headers(CE_REQUIRED) as { headers: Record<string, unknown> };
    delete noRequired.headers.required;
    expect(detectBuiltInTrait(noRequired)).toBeNull();
    // requiring MORE than the built-in does is fine
    expect(detectBuiltInTrait(headers([...CE_REQUIRED, "time"], [...CE_REQUIRED, "time"]))?.kind).toBe("cloudEvents");
  });

  it("a specversion pinned to another version is not the built-in (1.0); the same version, or no pin, is", () => {
    const withSpecversion = (schema: object) => headers(CE_REQUIRED, CE_REQUIRED, { specversion: schema });
    expect(detectBuiltInTrait(withSpecversion({ type: "string", const: "0.3" }))).toBeNull();
    expect(detectBuiltInTrait(withSpecversion({ type: "string", const: "2.0" }))).toBeNull();
    expect(detectBuiltInTrait(withSpecversion({ type: "string", const: "1.0" }))?.kind).toBe("cloudEvents");
    expect(detectBuiltInTrait(withSpecversion({ type: "string" }))?.kind).toBe("cloudEvents");
  });
});

describe("detectBuiltInTrait: W3C Trace Context", () => {
  it("recognises the built-in definition itself", () => {
    expect(detectBuiltInTrait(bundled("TraceContext"))).toEqual({ kind: "traceContext", name: "TraceContext" });
  });

  it("traceparent alone, or with tracestate (traceparent required)", () => {
    expect(detectBuiltInTrait(headers(["traceparent"]))?.kind).toBe("traceContext");
    expect(detectBuiltInTrait(headers(["traceparent", "tracestate"], ["traceparent"]))?.kind).toBe("traceContext");
  });

  it("traceparent must be required: optional headers are the user's own trait", () => {
    expect(detectBuiltInTrait(headers(["traceparent"], []))).toBeNull();
    expect(detectBuiltInTrait(headers(["traceparent", "tracestate"], ["tracestate"]))).toBeNull();
  });

  it("not tracestate alone, and not with any other property", () => {
    expect(detectBuiltInTrait(headers(["tracestate"]))).toBeNull();
    expect(detectBuiltInTrait(headers(["traceparent", "x-request-id"]))).toBeNull();
  });

  it("not a mix of both families", () => {
    expect(detectBuiltInTrait(headers([...CE_REQUIRED, "traceparent"]))).toBeNull();
  });
});

describe("detectBuiltInTrait: no match", () => {
  it("a trait with other headers", () => {
    expect(detectBuiltInTrait(headers(["ce_id", "ce_type", "ce_source"]))).toBeNull();
  });

  it("no headers, empty properties, or headers of the wrong shape", () => {
    expect(detectBuiltInTrait({ summary: "x" })).toBeNull();
    expect(detectBuiltInTrait({ headers: { type: "object" } })).toBeNull();
    expect(detectBuiltInTrait({ headers: { type: "object", properties: {} } })).toBeNull();
    expect(detectBuiltInTrait({ headers: { type: "object", properties: ["id"] } })).toBeNull();
    expect(detectBuiltInTrait({ headers: "specversion" })).toBeNull();
    expect(detectBuiltInTrait({ headers: [] })).toBeNull();
  });

  it("a required list that is not a list of names counts as no required list", () => {
    expect(detectBuiltInTrait({ headers: { required: "specversion", properties: Object.fromEntries(CE_REQUIRED.map((n) => [n, {}])) } })).toBeNull();
  });

  it("anything that is not an object", () => {
    for (const value of [null, undefined, "x", 3, []]) expect(detectBuiltInTrait(value)).toBeNull();
  });

  it("does not read inherited properties", () => {
    const properties = Object.create({ specversion: {}, id: {}, source: {}, type: {} }) as Record<string, unknown>;
    expect(detectBuiltInTrait({ headers: { required: CE_REQUIRED, properties } })).toBeNull();
  });
});

describe("builtInKindOfMarker", () => {
  it("names the family of every bundled definition by its `x-bundled` marker, and nothing else", () => {
    const kinds = BUNDLED_TRAITS.map((t) => builtInKindOfMarker(t.id));
    expect(kinds.sort()).toEqual(["cloudEvents", "traceContext"]);
    expect(builtInKindOfMarker("cloudevents@9.9")).toBe("cloudEvents"); // a later version of the family is still the family
    expect(builtInKindOfMarker("w3c-trace-context@2")).toBe("traceContext");
    for (const marker of ["", "other@1", "CloudEvents@1.0", "cloudevents"]) expect(builtInKindOfMarker(marker), marker).toBeNull();
  });
});
