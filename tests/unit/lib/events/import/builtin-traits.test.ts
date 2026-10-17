// tests/unit/lib/events/import/builtin-traits.test.ts
// WP-I1: a message trait whose headers look like CloudEvents or W3C Trace Context is recognised as the built-in library trait.
import { describe, expect, it } from "vitest";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";
import { builtInKindOfMarker, detectBuiltInTrait } from "@/lib/events/import/builtin-traits";

const headers = (...names: string[]) => ({ headers: { type: "object", properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])) } });
const bundled = (name: string) => structuredClone(BUNDLED_TRAITS.find((t) => t.name === name)?.spec) as Record<string, unknown>;

describe("detectBuiltInTrait: CloudEvents", () => {
  it("recognises the built-in definition itself (the names come from BUNDLED_TRAITS, not from a copy)", () => {
    expect(detectBuiltInTrait(bundled("CloudEvents"))).toEqual({ kind: "cloudEvents", name: "CloudEvents" });
  });

  it("needs all four required context attributes: specversion, id, source, type", () => {
    expect(detectBuiltInTrait(headers("specversion", "id", "source", "type"))?.kind).toBe("cloudEvents");
    for (const missing of ["specversion", "id", "source", "type"]) {
      const names = ["specversion", "id", "source", "type"].filter((n) => n !== missing);
      expect(detectBuiltInTrait(headers(...names)), `without ${missing}`).toBeNull();
    }
  });

  it("allows the optional attributes of the built-in and nothing else", () => {
    expect(detectBuiltInTrait(headers("specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"))?.kind).toBe("cloudEvents");
    expect(detectBuiltInTrait(headers("specversion", "id", "source", "type", "tenantid"))).toBeNull();
  });

  it("ignores the trait's documentation and other keys: only the headers decide", () => {
    const spec = { summary: "Envelope", description: "d", tags: [{ name: "x" }], ...headers("specversion", "id", "source", "type") };
    expect(detectBuiltInTrait(spec)?.kind).toBe("cloudEvents");
  });
});

describe("detectBuiltInTrait: W3C Trace Context", () => {
  it("recognises the built-in definition itself", () => {
    expect(detectBuiltInTrait(bundled("TraceContext"))).toEqual({ kind: "traceContext", name: "TraceContext" });
  });

  it("traceparent alone, or with tracestate", () => {
    expect(detectBuiltInTrait(headers("traceparent"))?.kind).toBe("traceContext");
    expect(detectBuiltInTrait(headers("traceparent", "tracestate"))?.kind).toBe("traceContext");
  });

  it("not tracestate alone, and not with any other property", () => {
    expect(detectBuiltInTrait(headers("tracestate"))).toBeNull();
    expect(detectBuiltInTrait(headers("traceparent", "x-request-id"))).toBeNull();
  });

  it("not a mix of both families", () => {
    expect(detectBuiltInTrait(headers("specversion", "id", "source", "type", "traceparent"))).toBeNull();
  });
});

describe("detectBuiltInTrait: no match", () => {
  it("a trait with other headers", () => {
    expect(detectBuiltInTrait(headers("ce_id", "ce_type", "ce_source"))).toBeNull();
  });

  it("no headers, empty properties, or headers of the wrong shape", () => {
    expect(detectBuiltInTrait({ summary: "x" })).toBeNull();
    expect(detectBuiltInTrait({ headers: { type: "object" } })).toBeNull();
    expect(detectBuiltInTrait({ headers: { type: "object", properties: {} } })).toBeNull();
    expect(detectBuiltInTrait({ headers: { type: "object", properties: ["id"] } })).toBeNull();
    expect(detectBuiltInTrait({ headers: "specversion" })).toBeNull();
    expect(detectBuiltInTrait({ headers: [] })).toBeNull();
  });

  it("anything that is not an object", () => {
    for (const value of [null, undefined, "x", 3, []]) expect(detectBuiltInTrait(value)).toBeNull();
  });

  it("does not read inherited properties", () => {
    const properties = Object.create({ specversion: {}, id: {}, source: {}, type: {} }) as Record<string, unknown>;
    expect(detectBuiltInTrait({ headers: { properties } })).toBeNull();
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
