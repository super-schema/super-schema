import { describe, it, expect, vi } from "vitest";
import { resolveDefinitionsForDomain, applyPolicyDefaults } from "@/lib/metadata-attributes/policy";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import type { PolicyTemplate } from "@/types/schemas/domain-policy";

const def = (over: Partial<MetadataAttributeDefinition> = {}): MetadataAttributeDefinition =>
  ({
    key: "x-abc",
    label: "ABC",
    description: "",
    valueSchema: { type: "object", properties: { data_category: { type: "string", enum: ["Intrinsic", "ConsumerPersonal"] }, data_class: { type: "string" } } },
    targets: ["field"],
    scope: "schema",
    requiredWhen: "never",
    ...over,
  }) as MetadataAttributeDefinition;

const policy = (attrs: Record<string, { requiredWhen?: "never" | "always" | "primitive"; default?: unknown }>): PolicyTemplate => ({ metadataAttributes: attrs });
const stored = (v: unknown) => ({ typespec: { extensions: { openapi: { "x-abc": v } } } });

describe("resolveDefinitionsForDomain", () => {
  it("turns a never definition into always with an override", () => {
    const out = resolveDefinitionsForDomain([def()], policy({ "x-abc": { requiredWhen: "always" } }));
    expect(out[0].requiredWhen).toBe("always");
  });
  it("leaves definitions alone without a policy or for another key", () => {
    const d = def();
    expect(resolveDefinitionsForDomain([d], null)[0]).toBe(d);
    expect(resolveDefinitionsForDomain([d], policy({ "x-other": { requiredWhen: "always" } }))[0]).toBe(d);
  });
  it("ignores an override for an unknown key (nothing is added)", () => {
    expect(resolveDefinitionsForDomain([], policy({ "x-ghost": { requiredWhen: "always" } }))).toEqual([]);
  });
});

describe("applyPolicyDefaults", () => {
  it("fills an absent attribute with the domain default", () => {
    const p = policy({ "x-abc": { default: { data_category: "Intrinsic" } } });
    expect(applyPolicyDefaults({}, [def()], p)).toEqual(stored({ data_category: "Intrinsic" }));
  });
  it("never overwrites an existing value", () => {
    const p = policy({ "x-abc": { default: { data_category: "Intrinsic" } } });
    const existing = stored({ data_category: "ConsumerPersonal" });
    expect(applyPolicyDefaults(existing, [def()], p)).toEqual(existing);
  });
  it("ignores an invalid default with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = policy({ "x-abc": { default: { data_category: "Nope" } } });
    expect(applyPolicyDefaults({}, [def()], p)).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("does nothing for a domain without defaults", () => {
    expect(applyPolicyDefaults({}, [def()], null)).toEqual({});
    expect(applyPolicyDefaults({}, [def()], policy({ "x-abc": { requiredWhen: "always" } }))).toEqual({});
  });
});
