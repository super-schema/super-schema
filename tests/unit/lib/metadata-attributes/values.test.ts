import { describe, it, expect } from "vitest";
import { readFieldAttributes, writeFieldAttribute, readEntityAttributes, writeEntityAttribute } from "@/lib/metadata-attributes/values";

describe("field attribute values", () => {
  it("reads only x-keys from typespec.extensions.openapi", () => {
    const d = { typespec: { extensions: { openapi: { "x-a": 1, other: 2 } } } };
    expect(readFieldAttributes(d)).toEqual({ "x-a": 1 });
    expect(readFieldAttributes({})).toEqual({});
    expect(readFieldAttributes(null)).toEqual({});
  });

  it("writes a value without touching siblings and without mutating the input", () => {
    const d = { structure: { key: true }, typespec: { extensions: { openapi: { "x-a": 1 }, other: true } } };
    const next = writeFieldAttribute(d, "x-b", { v: 1 });
    expect(next).toEqual({ structure: { key: true }, typespec: { extensions: { openapi: { "x-a": 1, "x-b": { v: 1 } }, other: true } } });
    expect(d.typespec.extensions.openapi).toEqual({ "x-a": 1 });
  });

  it("creates the containers on first write and prunes them when the last value is removed", () => {
    const written = writeFieldAttribute({}, "x-a", "v");
    expect(written).toEqual({ typespec: { extensions: { openapi: { "x-a": "v" } } } });
    expect(writeFieldAttribute(written, "x-a", undefined)).toEqual({});
  });
});

describe("entity attribute values", () => {
  it("reads and writes metadata.custom.extensions", () => {
    const m = { tags: ["t"], custom: { extensions: { "x-e": 1, plain: 2 }, keep: 1 } };
    expect(readEntityAttributes(m)).toEqual({ "x-e": 1 });
    expect(writeEntityAttribute(m, "x-f", "z")).toEqual({ tags: ["t"], custom: { extensions: { "x-e": 1, plain: 2, "x-f": "z" }, keep: 1 } });
    expect(writeEntityAttribute({ custom: { extensions: { "x-e": 1 } } }, "x-e", undefined)).toEqual({});
    expect(readEntityAttributes(undefined)).toEqual({});
  });
});
