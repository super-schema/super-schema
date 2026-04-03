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

  it("suggests utcDateTime for _at suffixed fields", () => {
    expect(suggestType("created_at")).toBe("utcDateTime");
    expect(suggestType("updated_at")).toBe("utcDateTime");
  });

  it("suggests plainDate for _date suffixed fields", () => {
    expect(suggestType("birth_date")).toBe("plainDate");
    expect(suggestType("start_date")).toBe("plainDate");
  });

  it("suggests plainTime for _time suffixed fields", () => {
    expect(suggestType("start_time")).toBe("plainTime");
    expect(suggestType("end_time")).toBe("plainTime");
  });

  it("suggests enum for status/type fields", () => {
    expect(suggestType("status")).toBe("enum");
    expect(suggestType("type")).toBe("enum");
    expect(suggestType("category")).toBe("enum");
  });

  it("suggests string for id fields", () => {
    expect(suggestType("id")).toBe("string");
    expect(suggestType("uuid")).toBe("string");
  });

  it("suggests bytes for binary fields", () => {
    expect(suggestType("image")).toBe("bytes");
    expect(suggestType("file")).toBe("bytes");
    expect(suggestType("attachment")).toBe("bytes");
  });

  it("suggests object for structured data fields", () => {
    expect(suggestType("data")).toBe("object");
    expect(suggestType("metadata")).toBe("object");
    expect(suggestType("config")).toBe("object");
  });

  it("returns null for unrecognized names", () => {
    expect(suggestType("xyz_abc")).toBeNull();
    expect(suggestType("")).toBeNull();
  });
});
