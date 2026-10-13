import { describe, expect, it } from "vitest";
import {
  parseSchemaTargetTypeOverrides,
  toFieldOverridePolicies,
  type SchemaTargetTypeOverrides,
} from "@/lib/schema-targets/field-type-overrides";

describe("field-type-overrides", () => {
  it("drops legacy overrides with target types outside the catalog", () => {
    const overrides = parseSchemaTargetTypeOverrides({
      bigquery: {
        field1: {
          fieldId: "field1",
          fieldName: "name",
          sourceType: "string",
          target: "bigquery",
          defaultMappedType: "STRING",
          mappedType: "STRING); DROP TABLE users; --",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          comment: "bad legacy value",
        },
      },
    });

    expect(overrides).toEqual({});
  });

  it("marks risky field override policies with loss metadata", () => {
    const overrides: SchemaTargetTypeOverrides = {
      openapi: {
        amount: {
          fieldId: "amount",
          fieldName: "amount",
          sourceType: "decimal",
          target: "openapi",
          defaultMappedType: "number/double",
          mappedType: "number/double",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          comment: "explicitly kept lossy default",
        },
      },
    };

    const [policy] = toFieldOverridePolicies(overrides, "openapi");

    expect(policy.isLossy).toBe(true);
    expect(policy.lossDescription).toContain("float64");
  });
});
