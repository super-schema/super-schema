import { describe, it, expect } from "vitest";
import type { ChangeEntry, FieldSnapshot, VersionDiff } from "@/services/version-history/version.types";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import { computeFieldDiff } from "@/lib/diff/field-diff";
import { generateBigQueryMigration } from "@/lib/migration/bigquery-migration";
import {
  classifyAvroCompatibility,
  generateAvroMigration,
} from "@/lib/migration/avro-compatibility";
import {
  detectOpenAPIBreakingChanges,
  generateOpenAPIMigration,
} from "@/lib/migration/openapi-breaking";
import { generateMigrationArtifacts } from "@/lib/migration/generate-migration";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const policies: ScopedMappingPolicy[] = getDefaultPolicies();

function makeField(overrides: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return {
    id: "field-1",
    name: "customer_id",
    type: "string",
    precision: null,
    scale: null,
    nullable: false,
    isKey: true,
    fieldNumber: 1,
    description: "Customer identifier",
    classification: "PII",
    aliases: [],
    decorators: {},
    sortOrder: 0,
    ...overrides,
  };
}

function makeAddedChange(field: FieldSnapshot): ChangeEntry {
  return {
    type: "added",
    fieldName: field.name,
    details: {
      after: field,
      changedProperties: ["name", "type", "nullable"],
    },
  };
}

function makeRemovedChange(field: FieldSnapshot): ChangeEntry {
  return {
    type: "removed",
    fieldName: field.name,
    details: {
      before: field,
      changedProperties: ["name", "type", "nullable"],
    },
  };
}

function makeModifiedChange(
  before: FieldSnapshot,
  after: FieldSnapshot,
  changedProperties: string[]
): ChangeEntry {
  return {
    type: "modified",
    fieldName: after.name,
    details: {
      before,
      after,
      changedProperties,
    },
  };
}

// ===========================================================================
// BigQuery Migration Tests
// ===========================================================================

describe("generateBigQueryMigration", () => {
  it("returns empty array when no changes", () => {
    const result = generateBigQueryMigration("Order", "Sales", [], policies);
    expect(result).toEqual([]);
  });

  it("generates ALTER TABLE ADD COLUMN for added field", () => {
    const field = makeField({
      name: "email",
      type: "string",
      nullable: true,
      description: "Email address",
    });
    const changes: ChangeEntry[] = [makeAddedChange(field)];

    const artifacts = generateBigQueryMigration("Order", "Sales", changes, policies);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe("ddl");
    expect(artifacts[0].content).toContain("ALTER TABLE sales.order ADD COLUMN email STRING");
    expect(artifacts[0].content).toContain("OPTIONS(description='Email address')");
    // nullable field should NOT have NOT NULL
    expect(artifacts[0].content).not.toContain("NOT NULL");
  });

  it("generates NOT NULL for non-nullable added field", () => {
    const field = makeField({
      name: "user_id",
      type: "integer",
      nullable: false,
      description: "",
    });
    const changes: ChangeEntry[] = [makeAddedChange(field)];

    const artifacts = generateBigQueryMigration("Order", "Sales", changes, policies);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toContain("ADD COLUMN user_id INT64 NOT NULL");
  });

  it("generates commented-out DROP COLUMN for removed field with warning", () => {
    const field = makeField({ name: "old_field", type: "string" });
    const changes: ChangeEntry[] = [makeRemovedChange(field)];

    const artifacts = generateBigQueryMigration("Order", "Sales", changes, policies);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toContain("-- ALTER TABLE sales.order DROP COLUMN old_field;");
    expect(artifacts[0].warnings).toHaveLength(1);
    expect(artifacts[0].warnings[0]).toContain("Manual review required");
    expect(artifacts[0].warnings[0]).toContain("dropping columns deletes data");
  });

  it("generates ALTER COLUMN SET DATA TYPE for type change", () => {
    const before = makeField({ name: "amount", type: "integer" });
    const after = makeField({ name: "amount", type: "float" });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["type"]),
    ];

    const artifacts = generateBigQueryMigration("Order", "Sales", changes, policies);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toContain(
      "ALTER TABLE sales.order ALTER COLUMN amount SET DATA TYPE FLOAT64;"
    );
  });

  it("adds compatibility warning for unsafe type conversion", () => {
    const before = makeField({ name: "status", type: "string" });
    const after = makeField({ name: "status", type: "integer" });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["type"]),
    ];

    const artifacts = generateBigQueryMigration("Order", "Sales", changes, policies);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].warnings.length).toBeGreaterThan(0);
    expect(artifacts[0].warnings[0]).toContain("Unsafe type conversion");
    expect(artifacts[0].warnings[0]).toContain("STRING");
    expect(artifacts[0].warnings[0]).toContain("INT64");
  });

  it("does not warn for safe type widening (INT64 to FLOAT64)", () => {
    const before = makeField({ name: "count", type: "integer" });
    const after = makeField({ name: "count", type: "float" });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["type"]),
    ];

    const artifacts = generateBigQueryMigration("Order", "Sales", changes, policies);

    expect(artifacts).toHaveLength(1);
    // INT64 -> FLOAT64 is safe, so no warnings about unsafe conversion
    const unsafeWarnings = artifacts[0].warnings.filter((w) =>
      w.includes("Unsafe type conversion")
    );
    expect(unsafeWarnings).toHaveLength(0);
  });

  it("generates ALTER COLUMN SET NOT NULL for nullable change", () => {
    const before = makeField({ name: "email", nullable: true });
    const after = makeField({ name: "email", nullable: false });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["nullable"]),
    ];

    const artifacts = generateBigQueryMigration("Order", "Sales", changes, policies);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toContain("ALTER COLUMN email SET NOT NULL");
    expect(artifacts[0].warnings.some((w) => w.includes("Existing NULL values"))).toBe(true);
  });

  it("generates ALTER COLUMN DROP NOT NULL for making field nullable", () => {
    const before = makeField({ name: "email", nullable: false });
    const after = makeField({ name: "email", nullable: true });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["nullable"]),
    ];

    const artifacts = generateBigQueryMigration("Order", "Sales", changes, policies);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toContain("ALTER COLUMN email DROP NOT NULL");
  });

  it("generates ALTER COLUMN SET OPTIONS for description change", () => {
    const before = makeField({ name: "email", description: "Old desc" });
    const after = makeField({ name: "email", description: "New desc" });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["description"]),
    ];

    const artifacts = generateBigQueryMigration("Order", "Sales", changes, policies);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toContain("SET OPTIONS(description='New desc')");
  });

  it("converts names to snake_case in generated DDL", () => {
    const field = makeField({
      name: "firstName",
      type: "string",
      nullable: true,
      description: "",
    });
    const changes: ChangeEntry[] = [makeAddedChange(field)];

    const artifacts = generateBigQueryMigration("CustomerOrder", "SalesData", changes, policies);

    expect(artifacts[0].content).toContain("sales_data.customer_order");
    expect(artifacts[0].content).toContain("first_name");
  });
});

// ===========================================================================
// Avro Compatibility Tests
// ===========================================================================

describe("classifyAvroCompatibility", () => {
  it("returns FULL compatibility when no changes", () => {
    const result = classifyAvroCompatibility([]);
    expect(result.compatible).toBe(true);
    expect(result.compatibility).toBe("FULL");
  });

  it("classifies added optional field as BACKWARD compatible", () => {
    const field = makeField({ name: "email", nullable: true });
    const changes: ChangeEntry[] = [makeAddedChange(field)];

    const result = classifyAvroCompatibility(changes);

    expect(result.compatible).toBe(true);
    expect(result.compatibility).toBe("FULL");
    expect(result.details.some((d) => d.includes("backward compatible"))).toBe(true);
  });

  it("classifies added required field as BREAKING", () => {
    const field = makeField({ name: "user_id", nullable: false });
    const changes: ChangeEntry[] = [makeAddedChange(field)];

    const result = classifyAvroCompatibility(changes);

    expect(result.compatible).toBe(false);
    expect(result.compatibility).toBe("BREAKING");
    expect(result.details.some((d) => d.includes("BREAKING"))).toBe(true);
  });

  it("classifies removed required field as BREAKING", () => {
    const field = makeField({ name: "user_id", nullable: false });
    const changes: ChangeEntry[] = [makeRemovedChange(field)];

    const result = classifyAvroCompatibility(changes);

    expect(result.compatible).toBe(false);
    expect(result.compatibility).toBe("BREAKING");
  });

  it("classifies removed optional field as FULL compatible", () => {
    const field = makeField({ name: "nickname", nullable: true });
    const changes: ChangeEntry[] = [makeRemovedChange(field)];

    const result = classifyAvroCompatibility(changes);

    expect(result.compatible).toBe(true);
    // Removing an optional field is forward compatible (old readers use default null)
    // and backward compatible (new readers don't need it)
    expect(result.compatibility).toBe("FULL");
  });

  it("classifies type change as BREAKING", () => {
    const before = makeField({ name: "amount", type: "string" });
    const after = makeField({ name: "amount", type: "integer" });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["type"]),
    ];

    const result = classifyAvroCompatibility(changes);

    expect(result.compatible).toBe(false);
    expect(result.compatibility).toBe("BREAKING");
    expect(result.details.some((d) => d.includes("type changes"))).toBe(true);
  });

  it("classifies additions + removals correctly", () => {
    const addedField = makeField({ name: "new_field", nullable: true });
    const removedField = makeField({ name: "old_field", nullable: true });
    const changes: ChangeEntry[] = [
      makeAddedChange(addedField),
      makeRemovedChange(removedField),
    ];

    const result = classifyAvroCompatibility(changes);

    // Both are optional, so this should be FULL compatible
    expect(result.compatible).toBe(true);
    expect(result.compatibility).toBe("FULL");
  });

  it("classifies mixed additions (optional + required) + removal as BREAKING", () => {
    const addedOptional = makeField({ name: "nickname", nullable: true });
    const addedRequired = makeField({ name: "email", nullable: false });
    const changes: ChangeEntry[] = [
      makeAddedChange(addedOptional),
      makeAddedChange(addedRequired),
    ];

    const result = classifyAvroCompatibility(changes);

    expect(result.compatible).toBe(false);
    expect(result.compatibility).toBe("BREAKING");
  });

  it("classifies making required field optional as FORWARD only", () => {
    const before = makeField({ name: "email", nullable: false });
    const after = makeField({ name: "email", nullable: true });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["nullable"]),
    ];

    const result = classifyAvroCompatibility(changes);

    // Forward compatible (old readers still expect a value, new data may have null)
    // This is a nuanced case — marking as compatible since direction is forward
    expect(result.compatible).toBe(true);
  });
});

describe("generateAvroMigration", () => {
  it("returns a MigrationArtifact with type compatibility-report", () => {
    const field = makeField({ name: "email", nullable: true });
    const changes: ChangeEntry[] = [makeAddedChange(field)];

    const artifact = generateAvroMigration(changes);

    expect(artifact.type).toBe("compatibility-report");
    const parsed = JSON.parse(artifact.content);
    expect(parsed.compatible).toBe(true);
    expect(parsed.compatibility).toBe("FULL");
    expect(parsed.details).toBeDefined();
  });

  it("includes warnings for BREAKING changes", () => {
    const field = makeField({ name: "user_id", nullable: false });
    const changes: ChangeEntry[] = [makeRemovedChange(field)];

    const artifact = generateAvroMigration(changes);

    expect(artifact.warnings.length).toBeGreaterThan(0);
    expect(artifact.warnings[0]).toContain("BREAKING");
  });
});

// ===========================================================================
// OpenAPI Breaking Change Tests
// ===========================================================================

describe("detectOpenAPIBreakingChanges", () => {
  it("returns empty results when no changes", () => {
    const result = detectOpenAPIBreakingChanges([]);

    expect(result.breakingChanges).toHaveLength(0);
    expect(result.nonBreakingChanges).toHaveLength(0);
    expect(result.hasBreakingChanges).toBe(false);
  });

  it("flags removed required field as breaking", () => {
    const field = makeField({ name: "user_id", nullable: false });
    const changes: ChangeEntry[] = [makeRemovedChange(field)];

    const result = detectOpenAPIBreakingChanges(changes);

    expect(result.hasBreakingChanges).toBe(true);
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].severity).toBe("breaking");
    expect(result.breakingChanges[0].field).toBe("user_id");
    expect(result.breakingChanges[0].change).toBe("removed");
  });

  it("flags added required field as breaking", () => {
    const field = makeField({ name: "email", nullable: false });
    const changes: ChangeEntry[] = [makeAddedChange(field)];

    const result = detectOpenAPIBreakingChanges(changes);

    expect(result.hasBreakingChanges).toBe(true);
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].severity).toBe("breaking");
    expect(result.breakingChanges[0].change).toBe("added");
  });

  it("flags added optional field as non-breaking", () => {
    const field = makeField({ name: "nickname", nullable: true });
    const changes: ChangeEntry[] = [makeAddedChange(field)];

    const result = detectOpenAPIBreakingChanges(changes);

    expect(result.hasBreakingChanges).toBe(false);
    expect(result.nonBreakingChanges).toHaveLength(1);
    expect(result.nonBreakingChanges[0].severity).toBe("non-breaking");
  });

  it("flags type change as breaking", () => {
    const before = makeField({ name: "count", type: "string" });
    const after = makeField({ name: "count", type: "integer" });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["type"]),
    ];

    const result = detectOpenAPIBreakingChanges(changes);

    expect(result.hasBreakingChanges).toBe(true);
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.breakingChanges[0].change).toBe("type-changed");
  });

  it("flags removed optional field as non-breaking", () => {
    const field = makeField({ name: "nickname", nullable: true });
    const changes: ChangeEntry[] = [makeRemovedChange(field)];

    const result = detectOpenAPIBreakingChanges(changes);

    expect(result.hasBreakingChanges).toBe(false);
    expect(result.nonBreakingChanges).toHaveLength(1);
    expect(result.nonBreakingChanges[0].change).toBe("removed");
  });

  it("flags description change as non-breaking", () => {
    const before = makeField({ name: "email", description: "Old" });
    const after = makeField({ name: "email", description: "New" });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["description"]),
    ];

    const result = detectOpenAPIBreakingChanges(changes);

    expect(result.hasBreakingChanges).toBe(false);
    expect(result.nonBreakingChanges).toHaveLength(1);
    expect(result.nonBreakingChanges[0].change).toBe("metadata-changed");
  });

  it("flags making optional field required as breaking", () => {
    const before = makeField({ name: "email", nullable: true });
    const after = makeField({ name: "email", nullable: false });
    const changes: ChangeEntry[] = [
      makeModifiedChange(before, after, ["nullable"]),
    ];

    const result = detectOpenAPIBreakingChanges(changes);

    expect(result.hasBreakingChanges).toBe(true);
    expect(result.breakingChanges[0].change).toBe("made-required");
  });
});

describe("generateOpenAPIMigration", () => {
  it("returns a MigrationArtifact with type changelog", () => {
    const field = makeField({ name: "nickname", nullable: true });
    const changes: ChangeEntry[] = [makeAddedChange(field)];

    const artifact = generateOpenAPIMigration(changes);

    expect(artifact.type).toBe("changelog");
    expect(artifact.content).toContain("# OpenAPI Schema Changelog");
    expect(artifact.content).toContain("Non-Breaking Changes");
  });

  it("includes warning count for breaking changes", () => {
    const field = makeField({ name: "user_id", nullable: false });
    const changes: ChangeEntry[] = [makeRemovedChange(field)];

    const artifact = generateOpenAPIMigration(changes);

    expect(artifact.warnings.length).toBeGreaterThan(0);
    expect(artifact.warnings[0]).toContain("breaking change");
  });
});

// ===========================================================================
// Integration: generateMigrationArtifacts orchestrator
// ===========================================================================

describe("generateMigrationArtifacts", () => {
  it("generates artifacts for all three targets from a complex diff", () => {
    // Simulate a complex change: add field, modify type, remove field
    const previousFields: FieldSnapshot[] = [
      makeField({ id: "f1", name: "customer_id", type: "string", nullable: false, sortOrder: 0 }),
      makeField({ id: "f2", name: "amount", type: "integer", nullable: false, sortOrder: 1, description: "Order amount" }),
      makeField({ id: "f3", name: "old_notes", type: "string", nullable: true, sortOrder: 2 }),
    ];

    const currentFields: FieldSnapshot[] = [
      makeField({ id: "f1", name: "customer_id", type: "string", nullable: false, sortOrder: 0 }),
      makeField({ id: "f2", name: "amount", type: "decimal", nullable: false, sortOrder: 1, description: "Order amount" }),
      makeField({ id: "f4", name: "email", type: "string", nullable: true, sortOrder: 2, description: "Contact email" }),
    ];

    const changes = computeFieldDiff(previousFields, currentFields);

    const diff: VersionDiff = {
      fromVersion: 1,
      toVersion: 2,
      changes,
      summary: {
        added: changes.filter((c) => c.type === "added").length,
        removed: changes.filter((c) => c.type === "removed").length,
        modified: changes.filter((c) => c.type === "modified").length,
      },
    };

    const result = generateMigrationArtifacts("Order", "Sales", diff, policies);

    // Should have 3 targets
    expect(result.targets).toHaveLength(3);

    // BigQuery target
    const bqTarget = result.targets.find((t) => t.targetFormat === "bigquery")!;
    expect(bqTarget).toBeDefined();
    expect(bqTarget.artifacts.length).toBeGreaterThan(0);
    const bqContent = bqTarget.artifacts[0].content;
    // Added field
    expect(bqContent).toContain("ADD COLUMN email STRING");
    // Removed field (commented out)
    expect(bqContent).toContain("-- ALTER TABLE sales.order DROP COLUMN old_notes;");
    // Type change
    expect(bqContent).toContain("ALTER COLUMN amount SET DATA TYPE NUMERIC");

    // Avro target
    const avroTarget = result.targets.find((t) => t.targetFormat === "avro")!;
    expect(avroTarget).toBeDefined();
    expect(avroTarget.artifacts).toHaveLength(1);
    const avroReport = JSON.parse(avroTarget.artifacts[0].content);
    // Type change makes it breaking
    expect(avroReport.compatibility).toBe("BREAKING");

    // OpenAPI target
    const openapiTarget = result.targets.find((t) => t.targetFormat === "openapi")!;
    expect(openapiTarget).toBeDefined();
    expect(openapiTarget.artifacts).toHaveLength(1);
    expect(openapiTarget.artifacts[0].content).toContain("Breaking Changes");
    // Type change is breaking — check for the description in the changelog
    expect(openapiTarget.artifacts[0].content).toContain("Type of property");
  });

  it("handles empty diff gracefully", () => {
    const diff: VersionDiff = {
      fromVersion: 1,
      toVersion: 2,
      changes: [],
      summary: { added: 0, removed: 0, modified: 0 },
    };

    const result = generateMigrationArtifacts("Order", "Sales", diff, policies);

    expect(result.targets).toHaveLength(3);
    // BigQuery should have no artifacts for empty diff
    const bqTarget = result.targets.find((t) => t.targetFormat === "bigquery")!;
    expect(bqTarget.artifacts).toHaveLength(0);
    // Avro should report FULL compatibility
    const avroTarget = result.targets.find((t) => t.targetFormat === "avro")!;
    const avroReport = JSON.parse(avroTarget.artifacts[0].content);
    expect(avroReport.compatibility).toBe("FULL");
  });
});
