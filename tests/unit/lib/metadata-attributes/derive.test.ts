import { describe, it, expect } from "vitest";
import { recomputeFieldAttributes } from "@/lib/metadata-attributes/derive";
import { readFieldAttributes } from "@/lib/metadata-attributes/values";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

const KEY = "x-abc";
const def: MetadataAttributeDefinition = {
  key: KEY,
  label: "ABC",
  description: "",
  valueSchema: { type: "object", properties: { data_class: { type: "string" }, data_category: { type: "string" } } },
  targets: ["field"],
  scope: "schema",
  placement: "abc-primitive",
  derive: { data_class: "class{class}" },
  requiredWhen: "primitive",
  pack: "paypal",
} as MetadataAttributeDefinition;

const withValue = (v: unknown) => ({ typespec: { extensions: { openapi: { [KEY]: v } } } });
const none = new Map<string, number>();
const attr = (d: Record<string, unknown>) => readFieldAttributes(d)[KEY];

describe("recomputeFieldAttributes", () => {
  it("derives data_class from PII and keeps the user's category", () => {
    const out = recomputeFieldAttributes(
      { name: "email", type: "string", classification: "PII", decorators: withValue({ data_category: "ConsumerPersonal" }) },
      [def],
      none,
    );
    expect(attr(out)).toEqual({ data_class: "class2", data_category: "ConsumerPersonal" });
  });

  it("re-derives when the classification changes, keeping the category", () => {
    const first = recomputeFieldAttributes(
      { name: "email", type: "string", classification: "PII", decorators: withValue({ data_category: "ConsumerPersonal" }) },
      [def],
      none,
    );
    const out = recomputeFieldAttributes({ name: "email", type: "string", classification: "PUBLIC", decorators: first }, [def], none);
    expect(attr(out)).toEqual({ data_class: "class5", data_category: "ConsumerPersonal" });
  });

  it("creates the value on an unclassified primitive with none (class 3)", () => {
    const out = recomputeFieldAttributes({ name: "x", type: "string", classification: null, decorators: {} }, [def], none);
    expect(attr(out)).toEqual({ data_class: "class3" });
  });

  it("does not create a value on a non-primitive field", () => {
    const d = {};
    expect(recomputeFieldAttributes({ name: "m", type: "map", classification: "PII", decorators: d }, [def], none)).toBe(d);
  });

  it("removes the key from a resolved entity reference field", () => {
    const out = recomputeFieldAttributes(
      { name: "addr", type: "reference", classification: "PII", decorators: { referencedEntityName: "Address", ...withValue({ data_class: "class2" }) } },
      [def],
      none,
    );
    expect(attr(out)).toBeUndefined();
    expect(out.referencedEntityName).toBe("Address");
  });

  it("keeps the key on a string[][] field", () => {
    const out = recomputeFieldAttributes(
      { name: "grid", type: "array", classification: "PII", decorators: { arrayElementType: "array", ...withValue({ data_category: "Intrinsic" }) } },
      [def],
      none,
    );
    expect(attr(out)).toEqual({ data_category: "Intrinsic", data_class: "class2" });
  });

  it("resolves a custom level through the custom map", () => {
    const out = recomputeFieldAttributes({ name: "amt", type: "decimal", classification: "FINANCIAL", decorators: {} }, [def], new Map([["FINANCIAL", 2]]));
    expect(attr(out)).toEqual({ data_class: "class2" });
  });

  it("resolves {level}, {name} and {type}", () => {
    const d2 = { ...def, derive: { data_class: "{level}:{name}:{type}" } } as MetadataAttributeDefinition;
    const out = recomputeFieldAttributes({ name: "n", type: "string", classification: "PII", decorators: {} }, [d2], none);
    expect(attr(out)).toEqual({ data_class: "PII:n:string" });
  });

  it("returns the same decorators reference with no defs or when nothing changes", () => {
    const d = { a: 1 };
    expect(recomputeFieldAttributes({ name: "x", type: "string", classification: "PII", decorators: d }, [], none)).toBe(d);
    const settled = withValue({ data_class: "class2" });
    expect(recomputeFieldAttributes({ name: "x", type: "string", classification: "PII", decorators: settled }, [def], none)).toBe(settled);
  });
});
