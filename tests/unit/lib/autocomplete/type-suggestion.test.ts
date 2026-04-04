import { describe, it, expect } from "vitest";
import { suggestType } from "@/lib/autocomplete/type-suggestion";

describe("suggestType", () => {
  it("suggests decimal for amount fields", () => {
    expect(suggestType("amount")).toEqual({ type: "decimal" });
    expect(suggestType("price")).toEqual({ type: "decimal" });
    expect(suggestType("balance")).toEqual({ type: "decimal" });
    expect(suggestType("total")).toEqual({ type: "decimal" });
  });

  it("suggests integer for count fields", () => {
    expect(suggestType("count")).toEqual({ type: "integer" });
    expect(suggestType("quantity")).toEqual({ type: "integer" });
    expect(suggestType("age")).toEqual({ type: "integer" });
  });

  it("suggests boolean for is_ prefixed fields", () => {
    expect(suggestType("is_active")).toEqual({ type: "boolean" });
    expect(suggestType("has_permission")).toEqual({ type: "boolean" });
    expect(suggestType("can_edit")).toEqual({ type: "boolean" });
  });

  it("suggests utcDateTime for _at suffixed fields", () => {
    expect(suggestType("created_at")).toEqual({ type: "utcDateTime" });
    expect(suggestType("updated_at")).toEqual({ type: "utcDateTime" });
  });

  it("suggests plainDate for _date suffixed fields", () => {
    expect(suggestType("birth_date")).toEqual({ type: "plainDate" });
    expect(suggestType("start_date")).toEqual({ type: "plainDate" });
  });

  it("suggests plainTime for _time suffixed fields", () => {
    expect(suggestType("start_time")).toEqual({ type: "plainTime" });
    expect(suggestType("end_time")).toEqual({ type: "plainTime" });
  });

  it("suggests enum for status/type fields", () => {
    expect(suggestType("status")).toEqual({ type: "enum" });
    expect(suggestType("type")).toEqual({ type: "enum" });
    expect(suggestType("category")).toEqual({ type: "enum" });
  });

  it("suggests string with isKey for id fields", () => {
    expect(suggestType("id")).toEqual({ type: "string", isKey: true });
    expect(suggestType("uuid")).toEqual({ type: "string", isKey: true });
    expect(suggestType("user_id")).toEqual({ type: "string", isKey: true });
  });

  it("suggests bytes for binary fields", () => {
    expect(suggestType("image")).toEqual({ type: "bytes" });
    expect(suggestType("file")).toEqual({ type: "bytes" });
    expect(suggestType("attachment")).toEqual({ type: "bytes" });
  });

  it("suggests object for structured data fields", () => {
    expect(suggestType("data")).toEqual({ type: "object" });
    expect(suggestType("metadata")).toEqual({ type: "object" });
    expect(suggestType("config")).toEqual({ type: "object" });
  });

  it("is case insensitive", () => {
    expect(suggestType("Amount")).toEqual({ type: "decimal" });
    expect(suggestType("IS_ACTIVE")).toEqual({ type: "boolean" });
  });

  it("returns null for unrecognized names", () => {
    expect(suggestType("xyz_abc")).toBeNull();
    expect(suggestType("")).toBeNull();
  });
});
