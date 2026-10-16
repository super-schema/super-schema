import { describe, expect, it } from "vitest";
import {
  errorsFor, isEmptyValue, isFieldSet, matchesPointer, omitKey, setField, singular, whenMatches,
} from "@/features/events/builder/template/value";
import type { FieldTemplate } from "@/lib/events/templates";

describe("isEmptyValue", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["the empty string", ""],
    ["an empty array", []],
    ["an empty object", {}],
    ["an object whose values are all empty strings", { a: "", b: "" }],
    ["an object nested several levels deep that holds nothing", { a: { b: { c: [] } }, d: undefined }],
  ])("%s is empty", (_name, value) => {
    expect(isEmptyValue(value)).toBe(true);
  });

  it.each([
    ["a non-empty string", "x"],
    ["whitespace (the form does not trim what the user types)", " "],
    ["zero", 0],
    ["false", false],
    ["true", true],
    ["a non-empty array", ["a"]],
    ["an array holding an empty object (the item card must stay)", [{}]],
    ["an object with one set value", { a: "", b: "x" }],
    ["an object holding a zero", { a: 0 }],
    ["an object holding false", { a: false }],
    ["a deeply nested value", { a: { b: { c: ["z"] } } }],
  ])("%s is not empty", (_name, value) => {
    expect(isEmptyValue(value)).toBe(false);
  });
});

describe("setField", () => {
  it("sets a new key and keeps the others", () => {
    expect(setField({ a: "1" }, "b", "2")).toEqual({ a: "1", b: "2" });
  });

  it("replaces an existing key in place (key order is kept)", () => {
    const next = setField({ a: "1", b: "2", c: "3" }, "b", "two");
    expect(next).toEqual({ a: "1", b: "two", c: "3" });
    expect(Object.keys(next)).toEqual(["a", "b", "c"]);
  });

  it("never mutates the object it was given", () => {
    const input = Object.freeze({ a: "1", nested: Object.freeze({ x: "y" }) });
    expect(() => setField(input, "a", "2")).not.toThrow();
    expect(() => setField(input, "a", "")).not.toThrow();
    expect(input).toEqual({ a: "1", nested: { x: "y" } });
  });

  it.each([
    ["undefined", undefined],
    ["the empty string", ""],
    ["an empty array", []],
    ["an empty object", {}],
    ["an object whose values are all empty", { name: "", url: "" }],
    ["an object that is empty all the way down", { a: { b: [] } }],
  ])("removes the key when the next value is %s", (_name, next) => {
    const result = setField({ title: "T", target: "old" }, "target", next);
    expect(result).toEqual({ title: "T" });
    expect("target" in result).toBe(false);
  });

  it("removing a key that is not there leaves the object equal", () => {
    expect(setField({ a: "1" }, "b", "")).toEqual({ a: "1" });
  });

  it("keeps values that are falsy but meaningful (0 and false)", () => {
    expect(setField({}, "port", 0)).toEqual({ port: 0 });
    expect(setField({}, "deprecated", false)).toEqual({ deprecated: false });
  });

  it("keeps an array that holds only an empty item, so an added item card stays", () => {
    expect(setField({}, "examples", [{}])).toEqual({ examples: [{}] });
  });

  it("preserves keys the template does not know (x- extensions, newer spec properties) on every change", () => {
    const value = { title: "T", "x-owner": "payments", futureProperty: { deep: [1, 2] } };
    expect(setField(value, "title", "New")).toEqual({ title: "New", "x-owner": "payments", futureProperty: { deep: [1, 2] } });
    expect(setField(value, "title", "")).toEqual({ "x-owner": "payments", futureProperty: { deep: [1, 2] } });
  });

  it("keeps the identity of untouched nested values", () => {
    const nested = { x: "y" };
    const result = setField({ nested, a: "1" }, "a", "2");
    expect(result.nested).toBe(nested);
  });

  describe("keepEmptyEntries (maps whose entries are meaningful even when empty)", () => {
    it("keeps a map whose entries are empty objects, like a declared channel parameter", () => {
      expect(setField({}, "parameters", { userId: {} }, { keepEmptyEntries: true })).toEqual({ parameters: { userId: {} } });
    });

    it("keeps a key-value map holding an empty value", () => {
      expect(setField({}, "labels", { env: "" }, { keepEmptyEntries: true })).toEqual({ labels: { env: "" } });
    });

    it("still removes a map with no entries at all", () => {
      expect(setField({ parameters: { a: {} }, t: "x" }, "parameters", {}, { keepEmptyEntries: true })).toEqual({ t: "x" });
    });

    it("still removes undefined and the empty string", () => {
      expect(setField({ a: "1" }, "a", undefined, { keepEmptyEntries: true })).toEqual({});
      expect(setField({ a: "1" }, "a", "", { keepEmptyEntries: true })).toEqual({});
    });
  });
});

describe("omitKey", () => {
  it("returns a copy without the key", () => {
    const input = { a: "1", b: "2" };
    expect(omitKey(input, "a")).toEqual({ b: "2" });
    expect(input).toEqual({ a: "1", b: "2" });
  });

  it("returns the same object when the key is absent", () => {
    const input = { a: "1" };
    expect(omitKey(input, "z")).toBe(input);
  });
});

describe("whenMatches (conditional visibility)", () => {
  const field = (when?: FieldTemplate["when"]): FieldTemplate => ({ key: "name", label: "Name", kind: "text", group: "basics", ...(when ? { when } : {}) });

  it("is always true for a field without a `when`", () => {
    expect(whenMatches(field(), {})).toBe(true);
  });

  it("is true while the sibling holds one of the listed values", () => {
    expect(whenMatches(field({ field: "type", oneOf: ["httpApiKey"] }), { type: "httpApiKey" })).toBe(true);
    expect(whenMatches(field({ field: "type", oneOf: ["apiKey", "httpApiKey"] }), { type: "apiKey" })).toBe(true);
  });

  it("is false when the sibling holds another value or nothing", () => {
    expect(whenMatches(field({ field: "type", oneOf: ["httpApiKey"] }), { type: "http" })).toBe(false);
    expect(whenMatches(field({ field: "type", oneOf: ["httpApiKey"] }), {})).toBe(false);
    expect(whenMatches(field({ field: "type", oneOf: ["httpApiKey"] }), { type: "" })).toBe(false);
  });

  it("compares booleans and numbers by their text", () => {
    expect(whenMatches(field({ field: "flag", oneOf: ["true"] }), { flag: true })).toBe(true);
    expect(whenMatches(field({ field: "n", oneOf: ["3"] }), { n: 3 })).toBe(true);
  });
});

describe("isFieldSet", () => {
  const f = (kind: FieldTemplate["kind"], extra: Partial<FieldTemplate> = {}): FieldTemplate => ({ key: "k", label: "K", kind, group: "more", ...extra });

  it("counts a text field with text, not an empty one", () => {
    expect(isFieldSet(f("text"), { k: "x" })).toBe(true);
    expect(isFieldSet(f("text"), { k: "" })).toBe(false);
    expect(isFieldSet(f("text"), {})).toBe(false);
  });

  it("counts a boolean that is false (it was set), not an unset one", () => {
    expect(isFieldSet(f("boolean"), { k: false })).toBe(true);
    expect(isFieldSet(f("boolean"), {})).toBe(false);
  });

  it("counts a key-value map that has an entry even when the entry's value is empty", () => {
    expect(isFieldSet(f("keyValue"), { k: { env: "" } })).toBe(true);
    expect(isFieldSet(f("keyValue"), { k: {} })).toBe(false);
  });

  it("counts a name-keyed list that has an entry even when the entry is empty", () => {
    expect(isFieldSet(f("list", { mapKeyLabel: "Name" }), { k: { id: {} } })).toBe(true);
  });

  it("counts a list with an item, even an empty one", () => {
    expect(isFieldSet(f("list"), { k: [{}] })).toBe(true);
    expect(isFieldSet(f("list"), { k: [] })).toBe(false);
  });
});

describe("pointers", () => {
  it("matches a pointer that equals the path or continues below it, on a segment boundary", () => {
    expect(matchesPointer("/servers/prod/host", "/servers/prod/host")).toBe(true);
    expect(matchesPointer("/servers/prod/host/0", "/servers/prod/host")).toBe(true);
    expect(matchesPointer("/servers/prod/hostname", "/servers/prod/host")).toBe(false);
    expect(matchesPointer("/servers/prod", "/servers/prod/host")).toBe(false);
  });

  it("errorsFor returns the messages of the matching problems, in order", () => {
    const errors = [
      { pointer: "/info/title", message: "Title is required" },
      { pointer: "/info/contact/email", message: "Not an email" },
      { pointer: "/info/titles", message: "other" },
      { pointer: "/info/title/x", message: "deeper" },
    ];
    expect(errorsFor(errors, "/info/title")).toEqual(["Title is required", "deeper"]);
    expect(errorsFor(errors, "/info/contact")).toEqual(["Not an email"]);
    expect(errorsFor(undefined, "/info/title")).toEqual([]);
  });

  it("errorsFor with exact: true leaves out problems deeper down (a container only shows its own)", () => {
    const errors = [{ pointer: "/a", message: "own" }, { pointer: "/a/b", message: "child" }];
    expect(errorsFor(errors, "/a", { exact: true })).toEqual(["own"]);
  });
});

describe("singular", () => {
  it("makes a plural label singular for the add / remove buttons", () => {
    expect(singular("Examples")).toBe("example");
    expect(singular("Variables")).toBe("variable");
    expect(singular("Properties")).toBe("property");
    expect(singular("Statements")).toBe("statement");
    expect(singular("Address")).toBe("address");
    expect(singular("Status")).toBe("status");
  });
});
