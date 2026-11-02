import { describe, expect, it } from "vitest";
import { unwritableFieldTypes } from "@/lib/typespec-sync/field-types";

const none = { enums: new Set<string>(), resolved: new Set<string>() };

describe("unwritableFieldTypes: the names a field may be typed with", () => {
  it("accepts an app type, a declared enum, a union with members and a field resolved to a tenant entity", () => {
    expect(
      unwritableFieldTypes(
        [
          { name: "a", type: "string" },
          { name: "b", type: "OrderStatus" },
          { name: "c", type: "union", unionMembers: ["Card", "Bank"] },
          { name: "d", type: "Customer" },
          { name: "e", type: "array", arrayElementType: "reference" },
        ],
        { enums: new Set(["OrderStatus"]), resolved: new Set(["d"]) },
      ),
    ).toEqual([]);
  });

  it("refuses a union of values (`\"open\" | \"closed\"`): it has no members and is no type of the app", () => {
    expect(unwritableFieldTypes([{ name: "status", type: "string | string" }], none)).toEqual([{ field: "status", written: "string | string" }]);
  });

  it("refuses void and a name that is not a type of the app", () => {
    expect(unwritableFieldTypes([{ name: "x", type: "void" }, { name: "y", type: "Price" }], none)).toEqual([
      { field: "x", written: "void" },
      { field: "y", written: "Price" },
    ]);
  });

  it("refuses an app type name that the source declares as a model of its own (the model takes the name over)", () => {
    expect(unwritableFieldTypes([{ name: "note", type: "object" }], { ...none, declaredModels: new Set(["object"]) })).toEqual([
      { field: "note", written: "object" },
    ]);
    // Without the declaration the same name is the app's own type.
    expect(unwritableFieldTypes([{ name: "note", type: "object" }], none)).toEqual([]);
  });
});
