import { describe, expect, it } from "vitest";
import { refusedImportFieldMessage, unwritableFieldTypes } from "@/lib/typespec-sync/field-types";

// The import refusal (shared by the TypeSpec and the OpenAPI import) and the planner's refusal read the same shapes: a field whose type names
// no type of the app is refused, an enum field or a union with members is not. A union of values reaches the planner as the text "string | string".

describe("refusedImportFieldMessage: the first field whose type is not a type of the app", () => {
  it("accepts enum fields (inline or declared) and fields of the app's types", () => {
    const message = refusedImportFieldMessage({
      models: [
        {
          name: "Order",
          fields: [
            { name: "status", type: "enum" },
            { name: "tags", type: "array", arrayElementType: "enum" },
            { name: "total", type: "decimal" },
          ],
        },
      ],
      sharedEnums: [],
    });
    expect(message).toBeNull();
  });

  it("refuses a field typed void, and names the model and the field", () => {
    const message = refusedImportFieldMessage({ models: [{ name: "Order", fields: [{ name: "note", type: "void" }] }], sharedEnums: [] });
    expect(message).toBe('Model "Order": field "note" is typed "void", which is not a type of this app: use a TypeSpec standard type, an enum, a union or a model of the text.');
  });

  it("refuses a union of values that is stored as its member text (a field and an array element alike)", () => {
    const field = refusedImportFieldMessage({ models: [{ name: "Order", fields: [{ name: "status", type: "string | string" }] }], sharedEnums: [] });
    expect(field).toContain('field "status" is typed "string | string"');
    const element = refusedImportFieldMessage({
      models: [{ name: "Order", fields: [{ name: "tags", type: "array", arrayElementType: "string | string" }] }],
      sharedEnums: [],
    });
    expect(element).toContain('field "tags" is typed "string | string"');
  });
});

describe("unwritableFieldTypes: the planner's refusal of a union of values", () => {
  it("refuses an array whose element is a union of values (its element text names no type)", () => {
    expect(unwritableFieldTypes([{ name: "tags", type: "array", arrayElementType: "string | string" }], { enums: new Set(), resolved: new Set() })).toEqual([
      { field: "tags", written: "string | string" },
    ]);
  });

  it("accepts a union of declared members (the union is checked where its members are declared)", () => {
    expect(
      unwritableFieldTypes([{ name: "pet", type: "union", unionMembers: ["Cat", "Dog"] }], { enums: new Set(), resolved: new Set() }),
    ).toEqual([]);
  });
});
