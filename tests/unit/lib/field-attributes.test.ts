import { describe, it, expect } from "vitest";
import {
  fieldDescription,
  fieldDeprecation,
  valueConstraintErrors,
  normalizeFieldDocumentation,
  fieldPresence,
  storeFieldPresence,
  fieldAttributeErrors,
  evolutionVersions,
} from "@/lib/field-attributes";

describe("canonical field documentation", () => {
  it("uses the canonical description and archives conflicting legacy text without losing other attributes", () => {
    const field = {
      description: "Canonical",
      decorators: {
        keep: true,
        typespec: {
          documentation: {
            doc: "Long legacy text",
            summary: "Short legacy text",
            example: 3,
          },
        },
      },
    };
    const result = normalizeFieldDocumentation(field);
    expect(result.description).toBe("Canonical");
    expect(result.decorators).toMatchObject({
      keep: true,
      legacyDocumentation: [
        { source: "doc", text: "Long legacy text" },
        { source: "summary", text: "Short legacy text" },
      ],
      typespec: { documentation: { example: 3 } },
    });
    expect(
      (result.decorators.typespec as { documentation: object }).documentation,
    ).not.toHaveProperty("summary");
    expect(normalizeFieldDocumentation(result)).toEqual(result);
    expect(field.decorators.typespec.documentation.doc).toBe(
      "Long legacy text",
    );
  });
  it("recovers a full legacy description before falling back to summary", () => {
    expect(
      fieldDescription({
        description: "",
        decorators: {
          typespec: { documentation: { doc: "Long", summary: "Short" } },
        },
      }),
    ).toBe("Long");
    expect(
      normalizeFieldDocumentation({
        decorators: { typespec: { documentation: { summary: "Only text" } } },
      }).description,
    ).toBe("Only text");
  });
  it("respects an explicitly cleared description and does not resurrect archived text", () => {
    const cleared = normalizeFieldDocumentation(
      { decorators: { typespec: { documentation: { doc: "Legacy" } } } },
      "",
    );
    expect(fieldDescription(cleared)).toBe("");
    expect(cleared.decorators.legacyDocumentation).toEqual([
      { source: "doc", text: "Legacy" },
    ]);
  });
});
describe("presence is separate from nullability", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("roundtrips optional=%s, allowNull=%s", (optional, allowNull) => {
    const stored = storeFieldPresence(optional, allowNull, {
      keep: "yes",
      nullableType: true,
      requiredNullable: true,
    });
    expect(fieldPresence(stored)).toEqual({ optional, allowNull });
    expect(stored.decorators.keep).toBe("yes");
  });
  it("keeps a key required and non-null even with stale legacy flags", () => {
    expect(
      fieldPresence({
        nullable: true,
        isKey: true,
        decorators: { nullableType: true },
      }),
    ).toEqual({ optional: false, allowNull: false });
  });
});
describe("cross-attribute validation", () => {
  it("rejects contradictory and empty bounds, negative lengths, invalid regex, decimal dimensions, and reserved field numbers", () => {
    expect(
      fieldAttributeErrors({
        precision: 4,
        scale: 5,
        fieldNumber: 19000,
        decorators: {
          typespec: {
            validation: {
              minValueExclusive: 5,
              maxValue: 5,
              minLength: -1,
              pattern: "[",
            },
          },
        },
      }),
    ).toHaveLength(5);
  });
  it("accepts zero scale, zero bounds, equal inclusive bounds, and valid identifiers", () => {
    expect(
      fieldAttributeErrors({
        precision: 1,
        scale: 0,
        fieldNumber: 536870911,
        decorators: { typespec: { validation: { minValue: 0, maxValue: 0 } } },
      }),
    ).toEqual([]);
  });
  it("rejects unsafe documentation URLs", () => {
    expect(
      fieldAttributeErrors({
        decorators: {
          typespec: {
            documentation: { externalDocsUrl: "javascript:alert(1)" },
          },
        },
      }),
    ).toEqual([
      "External documentation must use an absolute HTTP or HTTPS URL.",
    ]);
  });
  it("collects and numerically orders versions from every evolution control", () => {
    expect(
      evolutionVersions([
        {
          decorators: {
            typespec: {
              versioning: {
                added: "v1",
                removed: "v10",
                renamedFrom: { version: "v2", oldName: "old" },
              },
            },
          },
        },
      ]),
    ).toEqual(["v1", "v2", "v10"]);
  });
});

describe("legacy overrides and sample validation", () => {
  it("lets an explicit clear override imported deprecation", () => {
    expect(fieldDeprecation({ evolution: { deprecated: true } })).toBe(
      "deprecated",
    );
    expect(
      fieldDeprecation({
        evolution: { deprecated: true },
        typespec: { documentation: { deprecated: "" } },
      }),
    ).toBe("");
    expect(
      fieldDeprecation({
        evolution: { deprecated: true },
        typespec: { documentation: { deprecated: null } },
      }),
    ).toBeNull();
  });
  it("checks numeric, string and array examples without changing values", () => {
    expect(valueConstraintErrors(5, "int32", { minValueExclusive: 5 })).toEqual(
      ["Value must be greater than 5."],
    );
    expect(
      valueConstraintErrors("a", "string", { pattern: "^[0-9]+$" }),
    ).toEqual(["Value does not match the configured pattern."]);
    expect(valueConstraintErrors([], "array", { minItems: 1 })).toEqual([
      "Value must contain at least 1 items.",
    ]);
    expect(
      valueConstraintErrors("😀", "string", { minLength: 1, maxLength: 1 }),
    ).toEqual([]);
    expect(
      valueConstraintErrors("9223372036854775807", "int64", { minValue: 0 }),
    ).toEqual([]);
  });
});
