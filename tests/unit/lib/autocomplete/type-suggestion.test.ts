import { describe, it, expect } from "vitest";
import { suggestType } from "@/lib/autocomplete/type-suggestion";

describe("suggestType", () => {
  it("suggests decimal for amount fields", () => {
    expect(suggestType("amount")).toBe("decimal");
    expect(suggestType("price")).toBe("decimal");
    expect(suggestType("balance")).toBe("decimal");
    expect(suggestType("total")).toBe("decimal");
  });

  it("suggests integer for count fields", () => {
    expect(suggestType("count")).toBe("integer");
    expect(suggestType("quantity")).toBe("integer");
    expect(suggestType("age")).toBe("integer");
  });

  it("suggests boolean for is_ prefixed fields", () => {
    expect(suggestType("is_active")).toBe("boolean");
    expect(suggestType("has_permission")).toBe("boolean");
    expect(suggestType("can_edit")).toBe("boolean");
  });

  it("suggests timestamp for _at suffixed fields", () => {
    expect(suggestType("created_at")).toBe("timestamp");
    expect(suggestType("updated_at")).toBe("timestamp");
  });

  it("suggests date for _date suffixed fields", () => {
    expect(suggestType("birth_date")).toBe("date");
    expect(suggestType("start_date")).toBe("date");
  });

  it("suggests enum for status/type fields", () => {
    expect(suggestType("status")).toBe("enum");
    expect(suggestType("type")).toBe("enum");
    expect(suggestType("category")).toBe("enum");
  });

  it("suggests uuid for id fields", () => {
    expect(suggestType("id")).toBe("uuid");
    expect(suggestType("uuid")).toBe("uuid");
  });

  it("returns null for unrecognized names", () => {
    expect(suggestType("xyz_abc")).toBeNull();
    expect(suggestType("")).toBeNull();
  });
});
