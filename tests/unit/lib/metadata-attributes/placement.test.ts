import { describe, it, expect } from "vitest";
import { abcPlacement, isPrimitiveField } from "@/lib/metadata-attributes/placement";

describe("isPrimitiveField", () => {
  it.each(["string", "integer", "boolean", "enum", "utcDateTime", "decimal"])("%s is primitive", (type) => {
    expect(isPrimitiveField({ type })).toBe(true);
  });
  it("an object without properties (missing or empty nestedFields) is primitive; one with properties is not", () => {
    expect(isPrimitiveField({ type: "object" })).toBe(true);
    expect(isPrimitiveField({ type: "object", decorators: { nestedFields: [] } })).toBe(true);
    expect(isPrimitiveField({ type: "object", decorators: { nestedFields: [{ name: "a", type: "string" }] } })).toBe(false);
    expect(isPrimitiveField({ type: "object", complexType: { nestedFields: [{ name: "a", type: "string" }] } })).toBe(false);
  });
  it.each(["reference", "array", "map", "union"])("%s is not primitive", (type) => {
    expect(isPrimitiveField({ type })).toBe(false);
  });
});

describe("abcPlacement", () => {
  it("resolved entity reference -> none", () => {
    expect(abcPlacement({ type: "reference", decorators: { referencedEntityName: "Address" } })).toBe("none");
  });
  it("dangling reference -> field", () => {
    expect(abcPlacement({ type: "reference", decorators: { danglingRef: { ref: "https://x/y.json" } } })).toBe("field");
  });
  it("array of primitives -> items", () => {
    expect(abcPlacement({ type: "array", decorators: { arrayElementType: "string" } })).toBe("items");
    expect(abcPlacement({ type: "array" })).toBe("items");
  });
  it("array of references -> none; dangling array of references -> field", () => {
    expect(abcPlacement({ type: "array", decorators: { arrayElementType: "reference", referencedEntityName: "Address" } })).toBe("none");
    expect(abcPlacement({ type: "array", decorators: { arrayElementType: "reference", danglingRef: { ref: "r", element: true } } })).toBe("field");
  });
  it("nested array, map, object, scalar -> field", () => {
    expect(abcPlacement({ type: "array", decorators: { arrayElementType: "array" } })).toBe("field");
    expect(abcPlacement({ type: "map" })).toBe("field");
    expect(abcPlacement({ type: "object" })).toBe("field");
    expect(abcPlacement({ type: "string" })).toBe("field");
  });
  it("array of property-less objects -> items; array of objects with properties -> field", () => {
    expect(abcPlacement({ type: "array", decorators: { arrayElementType: "object" } })).toBe("items");
    expect(abcPlacement({ type: "array", decorators: { arrayElementType: "object", nestedFields: [] } })).toBe("items");
    expect(abcPlacement({ type: "array", decorators: { arrayElementType: "object", nestedFields: [{ name: "a", type: "string" }] } })).toBe("field");
  });
  it("reads arrayElementType from complexType when given", () => {
    expect(abcPlacement({ type: "array", complexType: { arrayElementType: "reference" } })).toBe("none");
  });
});
