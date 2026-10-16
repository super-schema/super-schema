import { describe, expect, it } from "vitest";
import {
  BUNDLED_MARKER_KEY, BUNDLED_TRAITS, bundledMarker, inlineHeadersProblem, isBundledTrait, propertySummary,
} from "@/lib/events/bundled-traits";
import { normalizeCatalogName, isJsonObject } from "@/lib/events/inputs";

const byName = (name: string) => {
  const found = BUNDLED_TRAITS.find((t) => t.name === name);
  if (!found) throw new Error(`no bundled trait ${name}`);
  return found;
};

describe("BUNDLED_TRAITS", () => {
  it("lists CloudEvents 1.0 and W3C Trace Context, both MESSAGE traits with unique ids and names", () => {
    expect(BUNDLED_TRAITS.map((t) => [t.name, t.kind, t.id])).toEqual([
      ["CloudEvents", "MESSAGE", "cloudevents@1.0"],
      ["TraceContext", "MESSAGE", "w3c-trace-context@1"],
    ]);
    expect(new Set(BUNDLED_TRAITS.map((t) => t.id)).size).toBe(BUNDLED_TRAITS.length);
    expect(new Set(BUNDLED_TRAITS.map((t) => t.name.toLowerCase())).size).toBe(BUNDLED_TRAITS.length);
  });

  it("names are valid library trait names (they become AsyncAPI component keys)", () => {
    for (const t of BUNDLED_TRAITS) expect(normalizeCatalogName(t.name, "Trait")).toEqual({ success: true, data: t.name });
  });

  it("marks every spec with its own id under x-bundled", () => {
    expect(BUNDLED_MARKER_KEY).toBe("x-bundled");
    for (const t of BUNDLED_TRAITS) expect(t.spec[BUNDLED_MARKER_KEY]).toBe(t.id);
    expect(byName("CloudEvents").spec["x-bundled"]).toBe("cloudevents@1.0");
    expect(byName("TraceContext").spec["x-bundled"]).toBe("w3c-trace-context@1");
  });

  it("CloudEvents: summary, description and the exact headers schema", () => {
    const { spec } = byName("CloudEvents");
    expect(typeof spec.summary).toBe("string");
    expect(typeof spec.description).toBe("string");
    const headers = spec.headers as Record<string, unknown>;
    expect(headers.type).toBe("object");
    expect(headers.required).toEqual(["specversion", "id", "source", "type"]);
    const properties = headers.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
    expect(properties.specversion).toMatchObject({ type: "string", const: "1.0" });
    expect(properties.id).toMatchObject({ type: "string", minLength: 1 });
    expect(properties.source).toMatchObject({ type: "string", format: "uri-reference" });
    expect(properties.type).toMatchObject({ type: "string" });
    expect(properties.subject).toMatchObject({ type: "string" });
    expect(properties.time).toMatchObject({ type: "string", format: "date-time" });
    expect(properties.datacontenttype).toMatchObject({ type: "string" });
    expect(properties.dataschema).toMatchObject({ type: "string", format: "uri" });
    for (const [name, schema] of Object.entries(properties)) {
      expect(typeof schema.description, `${name} has a description`).toBe("string");
      expect((schema.description as string).length).toBeGreaterThan(0);
    }
  });

  it("W3C Trace Context: traceparent is required, tracestate is optional, both described", () => {
    const headers = byName("TraceContext").spec.headers as Record<string, unknown>;
    expect(headers.type).toBe("object");
    expect(headers.required).toEqual(["traceparent"]);
    const properties = headers.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["traceparent", "tracestate"]);
    expect(properties.traceparent).toMatchObject({ type: "string" });
    expect(properties.tracestate).toMatchObject({ type: "string" });
    for (const schema of Object.values(properties)) expect(typeof schema.description).toBe("string");
    // the traceparent pattern accepts the W3C example and rejects a malformed value
    const pattern = new RegExp(properties.traceparent.pattern as string);
    expect(pattern.test("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBe(true);
    expect(pattern.test("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01")).toBe(false);
    expect(pattern.test("not-a-traceparent")).toBe(false);
  });

  it("every definition's headers schema passes its own shape check", () => {
    for (const t of BUNDLED_TRAITS) expect(inlineHeadersProblem(t.spec.headers)).toBeNull();
  });

  it("is deeply frozen: neither the list nor a definition can be edited by accident", () => {
    expect(Object.isFrozen(BUNDLED_TRAITS)).toBe(true);
    const ce = byName("CloudEvents");
    expect(Object.isFrozen(ce)).toBe(true);
    expect(Object.isFrozen(ce.spec)).toBe(true);
    expect(Object.isFrozen((ce.spec.headers as { required: string[] }).required)).toBe(true);
    expect(() => { (ce.spec as Record<string, unknown>).summary = "changed"; }).toThrow(TypeError);
  });

  it("a clone of a spec is a plain, editable JSON object", () => {
    const copy = structuredClone(byName("CloudEvents").spec);
    expect(isJsonObject(copy)).toBe(true);
    expect(Object.isFrozen(copy)).toBe(false);
    expect(copy).toEqual(byName("CloudEvents").spec);
  });
});

describe("isBundledTrait / bundledMarker", () => {
  it("is true for the built-in specs", () => {
    for (const t of BUNDLED_TRAITS) {
      expect(isBundledTrait(t.spec)).toBe(true);
      expect(bundledMarker(t.spec)).toBe(t.id);
    }
  });

  it("is true for any non-empty x-bundled string, even one this build does not know (a row is built in because it says so)", () => {
    expect(isBundledTrait({ "x-bundled": "future-thing@9" })).toBe(true);
    expect(bundledMarker({ "x-bundled": "future-thing@9" })).toBe("future-thing@9");
  });

  it.each([
    ["an empty spec", {}],
    ["a custom trait", { summary: "mine", headers: { type: "object" } }],
    ["an empty marker", { "x-bundled": "" }],
    ["a blank marker", { "x-bundled": "   " }],
    ["a non-string marker", { "x-bundled": true }],
    ["a numeric marker", { "x-bundled": 1 }],
    ["a nested marker", { headers: { "x-bundled": "cloudevents@1.0" } }],
    ["a look-alike key", { "x-bundle": "cloudevents@1.0", bundled: "cloudevents@1.0" }],
    ["null", null],
    ["undefined", undefined],
    ["a string", "cloudevents@1.0"],
    ["an array", ["x-bundled"]],
  ])("is false for %s", (_label, spec) => {
    expect(isBundledTrait(spec)).toBe(false);
    expect(bundledMarker(spec)).toBeNull();
  });
});

describe("propertySummary", () => {
  it("lists the eight CloudEvents properties in declared order with type, required and description", () => {
    const rows = propertySummary(byName("CloudEvents").spec);
    expect(rows.map((r) => r.name)).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
    expect(rows.map((r) => r.required)).toEqual([true, true, true, true, false, false, false, false]);
    expect(rows.map((r) => r.type)).toEqual([
      "string", "string", "string (uri-reference)", "string", "string", "string (date-time)", "string", "string (uri)",
    ]);
    for (const row of rows) expect(row.description?.length).toBeGreaterThan(0);
    expect(rows[0]).toEqual({
      name: "specversion", type: "string", required: true, description: 'The version of the CloudEvents specification the event uses. Always "1.0".',
    });
  });

  it("lists the two Trace Context properties", () => {
    const rows = propertySummary(byName("TraceContext").spec);
    expect(rows.map((r) => [r.name, r.required])).toEqual([["traceparent", true], ["tracestate", false]]);
  });

  it("reads the inline headers of a custom (non-bundled) trait: required first (in the order of `required`), then the rest as listed", () => {
    const rows = propertySummary({
      summary: "mine",
      headers: {
        type: "object",
        required: ["tenant"],
        properties: {
          retries: { type: "integer" },
          tenant: { type: "string", description: "Owning tenant" },
          priority: { type: ["integer", "null"], description: "" },
          flags: { enum: ["a", "b"] },
          fixed: { const: 7 },
          open: {},
          anything: true,
        },
      },
    });
    expect(rows).toEqual([
      { name: "tenant", type: "string", required: true, description: "Owning tenant" },
      { name: "retries", type: "integer", required: false },
      { name: "priority", type: "integer | null", required: false },
      { name: "flags", type: "enum", required: false },
      { name: "fixed", type: "number", required: false },
      { name: "open", type: "any", required: false },
      { name: "anything", type: "any", required: false },
    ]);
  });

  it("keeps the order of `required` for the required rows, whatever order the properties object lists them in", () => {
    const rows = propertySummary({
      headers: { type: "object", required: ["z", "a", "m"], properties: { a: { type: "string" }, m: { type: "string" }, x: { type: "string" }, z: { type: "string" } } },
    });
    expect(rows.map((r) => [r.name, r.required])).toEqual([["z", true], ["a", true], ["m", true], ["x", false]]);
  });

  it("shows a built-in trait in its definition's order even when the properties come back shuffled (PostgreSQL jsonb re-sorts keys by length)", () => {
    const stored = structuredClone(byName("CloudEvents").spec) as { headers: { properties: Record<string, unknown> } };
    const jsonbOrder = ["id", "time", "type", "source", "subject", "dataschema", "specversion", "datacontenttype"]; // what the database returned
    stored.headers.properties = Object.fromEntries(jsonbOrder.map((k) => [k, (byName("CloudEvents").spec.headers as { properties: Record<string, unknown> }).properties[k]]));
    expect(Object.keys(stored.headers.properties)).toEqual(jsonbOrder);
    expect(propertySummary(stored).map((r) => r.name)).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
  });

  it("puts a property the built-in definition does not know after the known ones", () => {
    const stored = structuredClone(byName("TraceContext").spec) as { headers: { properties: Record<string, unknown> } };
    stored.headers.properties = { extra: { type: "string" }, tracestate: stored.headers.properties.tracestate, traceparent: stored.headers.properties.traceparent };
    expect(propertySummary(stored).map((r) => r.name)).toEqual(["traceparent", "tracestate", "extra"]);
  });

  it("ignores a required name that is not a property and lists a repeated required name once", () => {
    const rows = propertySummary({ headers: { type: "object", required: ["ghost", "a", "a"], properties: { a: { type: "string" } } } });
    expect(rows).toEqual([{ name: "a", type: "string", required: true }]);
  });

  it("returns [] when the spec has no usable headers properties, and never throws", () => {
    for (const spec of [
      undefined, null, 5, "x", [], {}, { headers: null }, { headers: [] }, { headers: "x" }, { headers: {} }, { headers: { type: "object" } },
      { headers: { properties: [] } }, { headers: { properties: "x" } }, { headers: { properties: null } },
    ]) {
      expect(propertySummary(spec)).toEqual([]);
    }
  });

  it("ignores non-string entries in required and does not mark unknown names", () => {
    const rows = propertySummary({ headers: { type: "object", required: [1, null, "a", { x: 1 }], properties: { a: { type: "string" }, b: { type: "string" } } } });
    expect(rows.map((r) => [r.name, r.required])).toEqual([["a", true], ["b", false]]);
  });

  it("tolerates a non-array required", () => {
    const rows = propertySummary({ headers: { type: "object", required: "a", properties: { a: { type: "string" } } } });
    expect(rows).toEqual([{ name: "a", type: "string", required: false }]);
  });

  it("does not mutate the spec it reads", () => {
    const spec = structuredClone(byName("CloudEvents").spec);
    const before = JSON.stringify(spec);
    propertySummary(spec);
    expect(JSON.stringify(spec)).toBe(before);
  });
});

describe("inlineHeadersProblem", () => {
  const ok = { type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "integer" } } };

  it("accepts a well-formed object schema", () => {
    expect(inlineHeadersProblem(ok)).toBeNull();
    expect(inlineHeadersProblem({ type: "object" })).toBeNull();
    expect(inlineHeadersProblem({ type: "object", properties: {} , required: [] })).toBeNull();
    expect(inlineHeadersProblem({ type: "object", properties: { a: true, b: false } })).toBeNull();
  });

  it.each([
    ["not an object (string)", "x", /JSON Schema object/],
    ["not an object (array)", [], /JSON Schema object/],
    ["not an object (null)", null, /JSON Schema object/],
    ["no type", { properties: {} }, /"type": "object"/],
    ["a non-object type", { type: "string" }, /"type": "object"/],
    ["an array type", { type: ["object", "null"] }, /"type": "object"/],
    ["properties that is an array", { type: "object", properties: [] }, /"properties" must be an object/],
    ["properties that is a string", { type: "object", properties: "x" }, /"properties" must be an object/],
    ["properties that is null", { type: "object", properties: null }, /"properties" must be an object/],
    ["a property that is a string", { type: "object", properties: { a: "string" } }, /property "a" must be a schema/],
    ["a property that is a number", { type: "object", properties: { a: 1 } }, /property "a" must be a schema/],
    ["a property that is null", { type: "object", properties: { a: null } }, /property "a" must be a schema/],
    ["a property that is an array", { type: "object", properties: { a: [] } }, /property "a" must be a schema/],
    ["required that is a string", { type: "object", properties: { a: {} }, required: "a" }, /"required" must be a list/],
    ["required with a non-string", { type: "object", properties: { a: {} }, required: ["a", 2] }, /"required" must be a list/],
    ["required that is null", { type: "object", properties: { a: {} }, required: null }, /"required" must be a list/],
    ["required not in properties", { type: "object", properties: { a: {} }, required: ["a", "zzz"] }, /lists "zzz", which is not one of the headers properties/],
    ["required without any properties", { type: "object", required: ["a"] }, /lists "a"/],
    ["required naming an inherited key", { type: "object", properties: { a: {} }, required: ["toString"] }, /lists "toString"/],
  ])("rejects %s", (_label, headers, message) => {
    expect(inlineHeadersProblem(headers)).toMatch(message);
  });
});
