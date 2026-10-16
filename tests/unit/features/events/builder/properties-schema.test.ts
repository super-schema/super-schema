import { describe, expect, it } from "vitest";
import type { JsonObject } from "@/lib/event-specs/types";
import { BUNDLED_TRAITS, propertySummary } from "@/lib/events/bundled-traits";
import {
  allowedValues, descriptionOf, displayRowsFromHeaders, displayRowsFromSummary, duplicateNames, friendlyType, jsonEqual, PROPERTY_TYPES, readRows, setAllowedValues,
  setDescription, setType, summaryTypeLabel, typeLabel, writeHeaders, type PropertyRow,
} from "@/features/events/builder/properties-schema";

let n = 0;
const nextId = () => `id-${++n}`;
const row = (name: string, schema: PropertyRow["schema"] = { type: "string" }, required = false): PropertyRow => ({ id: nextId(), name, schema, required });
const cloudEventsHeaders = BUNDLED_TRAITS.find((t) => t.name === "CloudEvents")!.spec.headers as JsonObject;

describe("friendlyType and typeLabel: the six friendly types", () => {
  it("maps string, integer, number and boolean", () => {
    expect(friendlyType({ type: "string" })).toBe("text");
    expect(friendlyType({ type: "integer" })).toBe("integer");
    expect(friendlyType({ type: "number" })).toBe("number");
    expect(friendlyType({ type: "boolean" })).toBe("boolean");
  });

  it("maps string + date-time to Date-time and string + uri / uri-reference to Link", () => {
    expect(friendlyType({ type: "string", format: "date-time" })).toBe("date-time");
    expect(friendlyType({ type: "string", format: "uri" })).toBe("link");
    expect(friendlyType({ type: "string", format: "uri-reference" })).toBe("link");
  });

  it("keeps a string with another format as Text, and gives no friendly type to anything else", () => {
    expect(friendlyType({ type: "string", format: "email" })).toBe("text");
    expect(friendlyType({ type: "array" })).toBeNull();
    expect(friendlyType({ type: ["string", "null"] })).toBeNull();
    expect(friendlyType({})).toBeNull();
    expect(friendlyType(true)).toBeNull();
    expect(friendlyType("string")).toBeNull();
  });

  it("labels the friendly types the way users see them", () => {
    expect(PROPERTY_TYPES.map((t) => t.label)).toEqual(["Text", "Whole number", "Decimal", "True/false", "Date-time", "Link"]);
    expect(typeLabel({ type: "string" })).toBe("Text");
    expect(typeLabel({ type: "integer" })).toBe("Whole number");
    expect(typeLabel({ type: "number" })).toBe("Decimal");
    expect(typeLabel({ type: "boolean" })).toBe("True/false");
    expect(typeLabel({ type: "string", format: "date-time" })).toBe("Date-time");
    expect(typeLabel({ type: "string", format: "uri-reference" })).toBe("Link");
  });

  it("labels what has no friendly name, without hiding the format", () => {
    expect(typeLabel({ type: "string", format: "email" })).toBe("Text (email)");
    expect(typeLabel({ type: "array" })).toBe("List");
    expect(typeLabel({ type: "object" })).toBe("Object");
    expect(typeLabel({ type: ["string", "null"] })).toBe("string or null");
    expect(typeLabel({})).toBe("Any");
    expect(typeLabel(true)).toBe("Any");
    expect(typeLabel(false)).toBe("Nothing");
  });

  it("reads the loader's summary types with the same names", () => {
    expect(summaryTypeLabel("string")).toBe("Text");
    expect(summaryTypeLabel("string (date-time)")).toBe("Date-time");
    expect(summaryTypeLabel("string (uri-reference)")).toBe("Link");
    expect(summaryTypeLabel("integer")).toBe("Whole number");
    expect(summaryTypeLabel("any")).toBe("Any");
    expect(summaryTypeLabel("string | null")).toBe("string | null");
  });
});

describe("allowedValues and descriptionOf", () => {
  it("reads a const as one fixed value and an enum as a list", () => {
    expect(allowedValues({ type: "string", const: "1.0" })).toEqual({ kind: "const", values: ["1.0"] });
    expect(allowedValues({ type: "string", enum: ["a", "b"] })).toEqual({ kind: "enum", values: ["a", "b"] });
    expect(allowedValues({ type: "integer", enum: [1, 2] })).toEqual({ kind: "enum", values: ["1", "2"] });
    expect(allowedValues({ const: false })).toEqual({ kind: "const", values: ["false"] });
  });

  it("returns null when nothing is restricted", () => {
    expect(allowedValues({ type: "string" })).toBeNull();
    expect(allowedValues({ enum: [] })).toBeNull();
    expect(allowedValues({ const: { nested: true } })).toBeNull();
    expect(allowedValues(true)).toBeNull();
  });

  it("reads the description, or an empty text", () => {
    expect(descriptionOf({ description: "Hello" })).toBe("Hello");
    expect(descriptionOf({})).toBe("");
    expect(descriptionOf(true)).toBe("");
  });
});

describe("readRows: the order never depends on object key order", () => {
  it("lists the required properties first, in the order of `required`, then the others in the order given", () => {
    const headers = {
      type: "object",
      properties: { time: { type: "string" }, id: { type: "string" }, subject: { type: "string" }, type: { type: "string" }, source: { type: "string" } },
      required: ["source", "id", "type"],
    };
    const rows = readRows(headers, nextId);
    expect(rows.map((r) => r.name)).toEqual(["source", "id", "type", "time", "subject"]);
    expect(rows.map((r) => r.required)).toEqual([true, true, true, false, false]);
  });

  it("gives the same order for the same headers whatever order the object keys are in", () => {
    const a = { type: "object", properties: { b: { type: "string" }, a: { type: "string" } }, required: ["a"] };
    const b = { type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "string" } } };
    expect(readRows(a, nextId).map((r) => r.name)).toEqual(readRows(b, nextId).map((r) => r.name));
  });

  it("reads the real CloudEvents definition: required attributes first, the optional ones after", () => {
    const rows = readRows(cloudEventsHeaders, nextId);
    expect(rows.map((r) => r.name)).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
    expect(rows.filter((r) => r.required).map((r) => r.name)).toEqual(["specversion", "id", "source", "type"]);
    expect(rows.map((r) => r.name)).toEqual(propertySummary({ headers: cloudEventsHeaders }).map((r) => r.name));
  });

  it("ignores required names that are not properties, repeats, and a malformed schema", () => {
    expect(readRows({ type: "object", properties: { a: {} }, required: ["ghost", "a", "a"] }, nextId).map((r) => r.name)).toEqual(["a"]);
    expect(readRows(undefined, nextId)).toEqual([]);
    expect(readRows({ type: "object" }, nextId)).toEqual([]);
    expect(readRows({ properties: "nope" }, nextId)).toEqual([]);
    expect(readRows("x", nextId)).toEqual([]);
  });

  it("keeps each row's raw schema whole, boolean schemas included, and turns a non-schema into an empty one", () => {
    const rows = readRows({ type: "object", properties: { a: true, b: { type: "string", const: "x", "x-owner": "me" }, c: 5 } }, nextId);
    expect(rows.map((r) => r.schema)).toEqual([true, { type: "string", const: "x", "x-owner": "me" }, {}]);
  });

  it("gives every row its own id", () => {
    const rows = readRows({ type: "object", properties: { a: {}, b: {} } }, nextId);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
});

describe("writeHeaders: rows back to spec.headers", () => {
  it("writes an object schema with properties and required, keeping the row order", () => {
    const headers = writeHeaders([row("id", { type: "string" }, true), row("note", { type: "string", description: "n" }), row("count", { type: "integer" }, true)]);
    expect(headers).toEqual({
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string", description: "n" }, count: { type: "integer" } },
      required: ["id", "count"],
    });
    expect(Object.keys((headers as { properties: object }).properties)).toEqual(["id", "note", "count"]);
  });

  it("omits `required` when nothing is required", () => {
    expect(writeHeaders([row("a")])).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("returns undefined when there are no rows, so `headers` is removed", () => {
    expect(writeHeaders([])).toBeUndefined();
  });

  it("does not store a row without a name or with a name an earlier row has, and trims names", () => {
    const headers = writeHeaders([row("  id  ", { type: "string" }, true), row(""), row("   "), row("id", { type: "integer" })]);
    expect(headers).toEqual({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
    expect(writeHeaders([row("")])).toBeUndefined();
  });

  it("carries over the keys of the previous headers the table does not manage", () => {
    const headers = writeHeaders([row("a")], { type: "object", additionalProperties: false, title: "T", properties: { old: {} }, required: ["old"] });
    expect(headers).toEqual({ type: "object", additionalProperties: false, title: "T", properties: { a: { type: "string" } } });
  });

  it("round-trips the real CloudEvents definition without losing anything", () => {
    const rows = readRows(cloudEventsHeaders, nextId);
    expect(jsonEqual(writeHeaders(rows, cloudEventsHeaders), cloudEventsHeaders)).toBe(true);
  });

  it("names the duplicate names that are not stored", () => {
    expect([...duplicateNames([row("a"), row("b"), row("a"), row(""), row(" a ")])]).toEqual(["a"]);
    expect(duplicateNames([row("a"), row("b")]).size).toBe(0);
  });
});

describe("editing a row merges into its raw schema", () => {
  it("changes the type and keeps const, pattern, nested keys and x- extensions", () => {
    const raw = { type: "string", const: "1.0", pattern: "^1", "x-owner": "me", nested: { deep: true } };
    expect(setType(raw, "integer")).toEqual({ ...raw, type: "integer" });
  });

  it("writes Date-time and Link as a string with a format, and clears a managed format when the type changes away", () => {
    expect(setType({ type: "string" }, "date-time")).toEqual({ type: "string", format: "date-time" });
    expect(setType({ type: "string" }, "link")).toEqual({ type: "string", format: "uri" });
    expect(setType({ type: "string", format: "date-time", description: "d" }, "boolean")).toEqual({ type: "boolean", description: "d" });
    expect(setType({ type: "string", format: "uri" }, "text")).toEqual({ type: "string" });
  });

  it("keeps a format that is not a friendly one, and leaves a schema alone when it already has that type", () => {
    expect(setType({ type: "string", format: "email" }, "text")).toEqual({ type: "string", format: "email" });
    expect(setType({ type: "string", format: "email" }, "integer")).toEqual({ type: "integer", format: "email" });
    const reference = { type: "string", format: "uri-reference" };
    expect(setType(reference, "link")).toBe(reference);
  });

  it("turns a boolean or empty schema into an object when a type is chosen", () => {
    expect(setType(true, "text")).toEqual({ type: "string" });
    expect(setType({}, "number")).toEqual({ type: "number" });
  });

  it("sets and clears the description without touching anything else", () => {
    expect(setDescription({ type: "string", const: "x" }, "Hello")).toEqual({ type: "string", const: "x", description: "Hello" });
    expect(setDescription({ type: "string", description: "Hello" }, "")).toEqual({ type: "string" });
  });

  it("writes allowed values as an enum, a lone value of a const property as a const, and an empty list as nothing", () => {
    expect(setAllowedValues({ type: "string" }, ["a", "b"])).toEqual({ type: "string", enum: ["a", "b"] });
    expect(setAllowedValues({ type: "string" }, ["a"])).toEqual({ type: "string", enum: ["a"] });
    expect(setAllowedValues({ type: "string", const: "1.0" }, ["2.0"])).toEqual({ type: "string", const: "2.0" });
    expect(setAllowedValues({ type: "string", const: "1.0" }, ["1.0", "2.0"])).toEqual({ type: "string", enum: ["1.0", "2.0"] });
    expect(setAllowedValues({ type: "string", enum: ["a"], description: "d" }, [])).toEqual({ type: "string", description: "d" });
  });

  it("stores numbers for numeric properties and booleans for true/false ones", () => {
    expect(setAllowedValues({ type: "integer" }, ["1", "2"])).toEqual({ type: "integer", enum: [1, 2] });
    expect(setAllowedValues({ type: "number" }, ["1.5", "x"])).toEqual({ type: "number", enum: [1.5, "x"] });
    expect(setAllowedValues({ type: "boolean" }, ["true", "false"])).toEqual({ type: "boolean", enum: [true, false] });
    expect(setAllowedValues({ type: "string" }, ["1"])).toEqual({ type: "string", enum: ["1"] });
  });

  it("does not change the schema it was given", () => {
    const raw = { type: "string", description: "d" };
    setType(raw, "integer");
    setDescription(raw, "x");
    setAllowedValues(raw, ["a"]);
    expect(raw).toEqual({ type: "string", description: "d" });
  });
});

describe("jsonEqual", () => {
  it("ignores object key order and nothing else", () => {
    expect(jsonEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
    expect(jsonEqual(null, null)).toBe(true);
    expect(jsonEqual("a", "b")).toBe(false);
  });
});

describe("display rows", () => {
  it("builds the read-only rows of a headers schema with friendly types, descriptions and allowed values", () => {
    const rows = displayRowsFromHeaders(cloudEventsHeaders);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ name: "specversion", type: "Text", required: true, allowed: { kind: "const", values: ["1.0"] } });
    expect(rows[2]).toMatchObject({ name: "source", type: "Link", required: true });
    expect(rows[5]).toMatchObject({ name: "time", type: "Date-time", required: false });
    expect(rows[1].description).toContain("Identifies the event");
  });

  it("builds the rows of the loader's summary, in the order given", () => {
    const rows = displayRowsFromSummary([
      { name: "traceparent", type: "string", required: true, description: "The trace" },
      { name: "when", type: "string (date-time)", required: false },
    ]);
    expect(rows).toEqual([
      { name: "traceparent", type: "Text", required: true, description: "The trace", allowed: null },
      { name: "when", type: "Date-time", required: false, description: "", allowed: null },
    ]);
  });
});
