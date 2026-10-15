import { describe, expect, it } from "vitest";
import { isPlainObject, pickEditable, readFields, isString } from "@/lib/editable-fields";

// `isPlainObject` guards every client `data` payload of the update / create actions: a Date, Map, Set, RegExp, Error, typed
// array... has no own enumerable keys, so as `data` it used to pass the whitelist as `{}` and become a no-op update that
// still marked the draft changed.

describe("isPlainObject", () => {
  it.each([
    ["an object literal", {}],
    ["an object with keys", { a: 1 }],
    ["an object with a null prototype", Object.create(null)],
    ["a JSON.parse'd object with an own __proto__ key", JSON.parse('{"__proto__": {"x": 1}}')],
  ])("accepts %s", (_label, value) => {
    expect(isPlainObject(value)).toBe(true);
  });

  it.each([
    ["null", null], ["undefined", undefined], ["a string", "x"], ["a number", 5], ["a boolean", true], ["an array", []],
    ["a Date", new Date()], ["a Map", new Map()], ["a Set", new Set()], ["a RegExp", /x/], ["an Error", new Error("x")],
    ["a typed array", new Uint8Array(2)], ["a Promise", Promise.resolve()], ["a function", () => 1], ["a boxed string", Object("x")],
  ])("rejects %s", (_label, value) => {
    expect(isPlainObject(value)).toBe(false);
  });
});

describe("the payload gates reject non-plain objects", () => {
  const EDITABLE = { name: isString };
  it("pickEditable: a Date / Map / array / null is a VALIDATION_ERROR, not an empty update", () => {
    for (const data of [new Date(), new Map(), new Set(), [], null, undefined, "x", 5]) {
      expect(pickEditable(data, EDITABLE, "a field")).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("pickEditable: a plain object still passes", () => {
    expect(pickEditable({ name: "x" }, EDITABLE, "a field")).toEqual({ success: true, data: { name: "x" } });
    expect(pickEditable({}, EDITABLE, "a field")).toEqual({ success: true, data: {} });
  });

  it("readFields: a Date is a VALIDATION_ERROR", () => {
    expect(readFields(new Date(), {}, "an enum")).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
  });
});
