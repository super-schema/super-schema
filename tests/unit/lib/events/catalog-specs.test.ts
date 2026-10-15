import { describe, it, expect } from "vitest";
import { parseChannelSpec, parseMessageSpec, readMessageSpec, validateMessageSpec } from "@/lib/events/catalog-specs";

describe("channel spec", () => {
  it("keeps known AsyncAPI channel fields and drops unknown keys", () => {
    const r = parseChannelSpec({ title: "Orders", bindings: { kafka: { partitions: 12 } }, parameters: { region: { description: "r" } }, extra: 1 });
    expect(r).toEqual({ success: true, data: { title: "Orders", bindings: { kafka: { partitions: 12 } }, parameters: { region: { description: "r" } } } });
  });

  it("reports every wrongly-typed field together", () => {
    const r = parseChannelSpec({ title: 3, bindings: [], tags: [1] });
    expect(r.success).toBe(false);
    expect(!r.success && (r.error.details as { problems: string[] }).problems).toEqual([
      "title must be a string",
      "bindings must be an object",
      "tags must be an array of objects",
    ]);
  });
});

describe("message spec", () => {
  it("defaults traitIds to [] and keeps AsyncAPI message fields", () => {
    expect(parseMessageSpec({ contentType: "avro/binary" })).toEqual({ success: true, data: { contentType: "avro/binary", traitIds: [] } });
  });

  it("reads leniently from stored JSON (bad parts dropped)", () => {
    expect(readMessageSpec({ title: 7, traitIds: ["t1", 2] })).toEqual({ traitIds: ["t1"] });
    expect(readMessageSpec(null)).toEqual({ traitIds: [] });
  });

  it("flags semantic problems that block publish", () => {
    expect(
      validateMessageSpec({
        contentType: "avro binary",
        correlationId: { location: "header.id" },
        examples: [{ payload: {}, foo: 1 }],
        traitIds: ["t1", "t1"],
      })
    ).toEqual([
      "contentType must not contain whitespace",
      'correlationId.location must start with "$message.header#" or "$message.payload#"',
      'examples[0] has unsupported key "foo" (allowed: name, summary, headers, payload)',
      'trait "t1" is listed more than once',
    ]);
    expect(validateMessageSpec({ correlationId: { location: "$message.header#/ce_id" }, traitIds: [] })).toEqual([]);
  });
});
