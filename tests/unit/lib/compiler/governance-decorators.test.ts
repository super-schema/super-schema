import { describe, it, expect } from "vitest";
import {
  ENTERPRISE_LIBRARY_IMPORT,
  OPENAPI_LIBRARY_IMPORT,
  classificationDecorator,
  tagsDecorator,
  classificationFromEnterpriseMember,
  classificationFromDecorators,
  classificationFromLegacyTag,
  parseStringTuple,
} from "@/lib/compiler/governance-decorators";

describe("governance decorators (Story 16.6)", () => {
  it("names the two libraries the overlay can need", () => {
    expect(ENTERPRISE_LIBRARY_IMPORT).toBe('import "@superschema/typespec-enterprise";');
    expect(OPENAPI_LIBRARY_IMPORT).toBe('import "@typespec/openapi";');
  });

  it.each([
    ["PII", "PII"],
    ["INTERNAL", "Internal"],
    ["PUBLIC", "Public"],
    ["SENSITIVE", "Confidential"],
    ["NEVER_STORED", "Restricted"],
    ["FINANCIAL", "FINANCIAL"],
  ])("maps app level %s to the Enterprise.DataClassification member %s, and back", (level, member) => {
    expect(classificationDecorator(level)).toEqual({
      line: `@Enterprise.dataClassification(Enterprise.DataClassification.${member})`,
      library: "enterprise",
    });
    expect(classificationFromEnterpriseMember(member)).toBe(level);
    expect(classificationFromEnterpriseMember(`DataClassification.${member}`)).toBe(level);
    expect(classificationFromEnterpriseMember(`Enterprise.DataClassification.${member}`)).toBe(level);
  });

  it("carries a level with no enum member (admin-defined, or a colliding name) losslessly as x-classification", () => {
    expect(classificationDecorator("TOP_SECRET")).toEqual({
      line: '@TypeSpec.OpenAPI.extension("x-classification", "TOP_SECRET")',
      library: "openapi",
    });
    // CONFIDENTIAL / RESTRICTED are not aliased: SENSITIVE / NEVER_STORED own those members, so a custom
    // level with that name must not come back as SENSITIVE / NEVER_STORED.
    expect(classificationDecorator("CONFIDENTIAL").library).toBe("openapi");
    expect(classificationDecorator("pii").library).toBe("openapi"); // exact match only
    expect(classificationDecorator('odd "level"').line).toBe(
      '@TypeSpec.OpenAPI.extension("x-classification", "odd \\"level\\"")'
    );
  });

  it("renders entity tags as one x-tags extension with a value tuple", () => {
    expect(tagsDecorator(["sales", "pii"])).toBe('@TypeSpec.OpenAPI.extension("x-tags", #["sales", "pii"])');
    expect(tagsDecorator(['say "hi"'])).toBe('@TypeSpec.OpenAPI.extension("x-tags", #["say \\"hi\\""])');
  });

  it("parses a value tuple of strings back, unescaping", () => {
    expect(parseStringTuple('#["sales", "pii"]')).toEqual(["sales", "pii"]);
    expect(parseStringTuple('#["say \\"hi\\"", "back\\\\slash"]')).toEqual(['say "hi"', "back\\slash"]);
    expect(parseStringTuple("#[]")).toEqual([]);
    expect(parseStringTuple('"not a tuple"')).toBeUndefined();
  });

  it("returns undefined for an unknown member", () => {
    expect(classificationFromEnterpriseMember(undefined)).toBeUndefined();
    expect(classificationFromEnterpriseMember("DataClassification.Nope")).toBeUndefined();
  });

  it("reads the legacy @tag(\"classification:…\") form", () => {
    expect(classificationFromLegacyTag("classification:PII")).toBe("PII");
    expect(classificationFromLegacyTag("sales")).toBeUndefined();
    expect(classificationFromLegacyTag(undefined)).toBeUndefined();
  });

  it("prefers the parsed classification over the legacy tag", () => {
    expect(classificationFromDecorators({ classification: "SENSITIVE", tag: "classification:PII" })).toBe("SENSITIVE");
    expect(classificationFromDecorators({ tag: "classification:PII" })).toBe("PII");
    expect(classificationFromDecorators({})).toBeUndefined();
  });
});
