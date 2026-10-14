import { describe, it, expect } from "vitest";
import { formatSuffix, normalizeProfile, sameProfile, schemaFormatFor } from "@/lib/event-specs/schema-format";

describe("schemaFormatFor (spec §7.2 step 4)", () => {
  it.each([
    [{ format: "avro" as const }, "application/vnd.apache.avro+json;version=1.9.0"],
    [{ format: "protobuf" as const }, "application/vnd.google.protobuf;version=3"],
    [{ format: "json-schema" as const, dialect: "draft-07" as const }, "application/schema+json;version=draft-07"],
    [{ format: "json-schema" as const, dialect: "2020-12" as const }, "application/schema+json;version=2020-12"],
  ])("%o → %s", (profile, expected) => {
    expect(schemaFormatFor(profile)).toBe(expected);
  });

  it("defaults JSON Schema to draft-07", () => {
    expect(schemaFormatFor({ format: "json-schema" })).toBe("application/schema+json;version=draft-07");
    expect(normalizeProfile({ format: "json-schema" })).toEqual({ format: "json-schema", dialect: "draft-07" });
  });

  it("ignores a dialect on non-JSON formats", () => {
    expect(normalizeProfile({ format: "avro", dialect: "2020-12" })).toEqual({ format: "avro" });
    expect(sameProfile({ format: "avro", dialect: "2020-12" }, { format: "avro" })).toBe(true);
    expect(sameProfile({ format: "json-schema" }, { format: "json-schema", dialect: "2020-12" })).toBe(false);
  });

  it("format suffixes qualify multi-format messages", () => {
    expect(formatSuffix({ format: "avro" })).toBe("avro");
    expect(formatSuffix({ format: "json-schema" })).toBe("json");
    expect(formatSuffix({ format: "json-schema", dialect: "2020-12" })).toBe("json2020");
    expect(formatSuffix({ format: "protobuf" })).toBe("proto");
  });
});
