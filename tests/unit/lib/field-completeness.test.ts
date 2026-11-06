import { describe, it, expect } from "vitest";
import { getFieldCompleteness, getEntityCompleteness, canEmit, type FieldInput } from "@/lib/validation/field-completeness";
import { FieldCompletenessPolicySchema, readFieldCompletenessPolicy } from "@/types/schemas/field-completeness-policy";
import { PolicyTemplateSchema } from "@/types/schemas/domain-policy";
import { CreateDomainInputSchema } from "@/types/schemas/domain.schema";

const BOUNDS = { typespec: { validation: { minLength: 0, maxLength: 120 } } };
const field = (overrides: Partial<FieldInput> = {}): FieldInput => ({ name: "title", type: "string", classification: null, precision: null, scale: null, ...overrides });

describe("field completeness rules", () => {
  it("suggests each missing string bound without questioning default Class 3", () => {
    expect(getFieldCompleteness(field())).toEqual({ status: "suggestion", missing: [], suggestions: ["minLength", "maxLength"] });
  });
  it.each([null, "SENSITIVE", "PII"])("accepts classification %s when the configured information is present", (classification) => {
    expect(getFieldCompleteness(field({ classification, decorators: BOUNDS }))).toEqual({ status: "complete", missing: [], suggestions: [] });
  });
  it("keeps name and type structurally required", () => {
    expect(getFieldCompleteness(field({ name: " ", type: " " })).missing).toEqual(["name", "type"]);
  });
  it("requires decimal precision and scale by default", () => {
    expect(getFieldCompleteness(field({ type: "decimal" }))).toEqual({ status: "error", missing: ["precision", "scale"], suggestions: [] });
  });
  it("inherits decimal requirements for decimal128 and accepts scale zero", () => {
    expect(getFieldCompleteness(field({ type: "decimal128" })).missing).toEqual(["precision", "scale"]);
    expect(getFieldCompleteness(field({ type: "decimal128", precision: 12, scale: 0 })).status).toBe("complete");
  });
  it.each(["integer", "float", "float32", "float64"])("does not request decimal precision/scale for %s", (type) => {
    expect(getFieldCompleteness(field({ type })).status).toBe("complete");
  });
  it("recognizes minLength and maxLength zero as supplied constraints", () => {
    expect(getFieldCompleteness(field({ decorators: { typespec: { validation: { minLength: 0, maxLength: 0 } } } })).status).toBe("complete");
  });
  it("does not count malformed or negative constraints as present", () => {
    expect(getFieldCompleteness(field({ decorators: { typespec: { validation: { minLength: "1", maxLength: -1 } } } })).suggestions).toEqual(["minLength", "maxLength"]);
  });
  it("reports invalid decimal settings, including scale beyond precision", () => {
    expect(getFieldCompleteness(field({ type: "decimal", precision: 0, scale: -1 })).missing).toEqual(["precision", "scale"]);
    expect(getFieldCompleteness(field({ type: "decimal", precision: 4, scale: 5 })).missing).toEqual(["scale"]);
  });
  it("supports required, suggested and explicitly disabled rules", () => {
    expect(getFieldCompleteness(field(), { string: { minLength: "required", maxLength: "off" } })).toEqual({ status: "error", missing: ["minLength"], suggestions: [] });
    expect(getFieldCompleteness(field(), { string: { minLength: "off", maxLength: "off" } }).status).toBe("complete");
    expect(getFieldCompleteness(field({ type: "decimal" }), { decimal: { precision: "suggested", scale: "off" } })).toEqual({ status: "suggestion", missing: [], suggestions: ["precision"] });
  });
  it("inherits parent overrides, with the more specific type taking precedence", () => {
    const policy = { string: { minLength: "required", maxLength: "off" }, url: { minLength: "off" } } as const;
    expect(getFieldCompleteness(field(), policy).missing).toEqual(["minLength"]);
    expect(getFieldCompleteness(field({ type: "url" }), policy).status).toBe("complete");
  });
  it("supports common metadata checks and per-type exceptions", () => {
    expect(getFieldCompleteness(field({ type: "boolean" }), { "*": { description: "required" } }).missing).toEqual(["description"]);
    expect(getFieldCompleteness(field({ type: "boolean" }), { "*": { description: "required" }, boolean: { description: "off" } }).status).toBe("complete");
    expect(getFieldCompleteness(field({ type: "boolean", description: "Whether activation is allowed." }), { "*": { description: "required" } }).status).toBe("complete");
    expect(getFieldCompleteness(field({ type: "boolean", decorators: { typespec: { documentation: { summary: "Whether activation is allowed." } } } }), { "*": { description: "required" } }).status).toBe("complete");
  });
  it("supports numeric range checks, including exclusive bounds and zero", () => {
    const policy = { numeric: { minValue: "required", maxValue: "required" } } as const;
    expect(getFieldCompleteness(field({ type: "int32", decorators: { typespec: { validation: { minValueExclusive: 0, maxValue: 10 } } } }), policy).status).toBe("complete");
    expect(getFieldCompleteness(field({ type: "float64", decorators: { typespec: { validation: { minValue: NaN } } } }), policy).missing).toEqual(["minValue", "maxValue"]);
  });
  it("does not apply a type-specific rule to an incompatible type", () => {
    expect(getFieldCompleteness(field({ type: "boolean" }), { boolean: { precision: "required", minLength: "required" } }).status).toBe("complete");
  });
  it("supports a configured validation-pattern check", () => {
    const policy = { string: { pattern: "required" } } as const;
    expect(getFieldCompleteness(field({ decorators: BOUNDS }), policy).missing).toEqual(["pattern"]);
    expect(getFieldCompleteness(field({ decorators: { typespec: { validation: { ...BOUNDS.typespec.validation, pattern: "^[a-z]+$" } } } }), policy).status).toBe("complete");
  });
});

describe("field completeness summaries", () => {
  it("counts complete fields using the same policy as their indicators", () => {
    const fields = [field({ decorators: BOUNDS }), field({ name: "other" })];
    expect(getEntityCompleteness(fields)).toEqual({ complete: 1, total: 2, percentage: 50 });
    expect(getEntityCompleteness(fields, { string: { minLength: "off", maxLength: "off" } }).percentage).toBe(100);
    expect(getEntityCompleteness([])).toEqual({ complete: 0, total: 0, percentage: 0 });
  });
  it("distinguishes suggested from required checks for readiness", () => {
    expect(canEmit([field()])).toEqual({ allowed: true, incompleteCount: 0 });
    expect(canEmit([field()], { string: { minLength: "required" } })).toEqual({ allowed: false, incompleteCount: 1 });
    expect(canEmit([field({ type: "decimal" })]).allowed).toBe(false);
    expect(canEmit([field({ name: "" })]).allowed).toBe(false);
    expect(canEmit([]).allowed).toBe(false);
  });
});

describe("field completeness policy persistence", () => {
  const policy = { string: { minLength: "required", maxLength: "off" } } as const;
  it("accepts sparse overrides and preserves them in both domain input schemas", () => {
    expect(FieldCompletenessPolicySchema.parse(policy)).toEqual(policy);
    expect(PolicyTemplateSchema.parse({ fieldCompleteness: policy }).fieldCompleteness).toEqual(policy);
    expect(CreateDomainInputSchema.parse({ name: "Identity", policyTemplate: { fieldCompleteness: policy } }).policyTemplate?.fieldCompleteness).toEqual(policy);
  });
  it("rejects unknown rule IDs and unsupported levels", () => {
    expect(FieldCompletenessPolicySchema.safeParse({ string: { minLength: "mandatory" } }).success).toBe(false);
    expect(FieldCompletenessPolicySchema.safeParse({ string: { misspelledRule: "required" } }).success).toBe(false);
    expect(readFieldCompletenessPolicy({ string: { minLength: false } })).toBeUndefined();
  });
});
