import { describe, it, expect } from "vitest";

import {
  generateImpactReport,
  computeMigrationComplexity,
} from "@/services/impact-report.service";
import type { ChangeClassification } from "@/types/schemas/classification";
import type { DiffResult, FieldSnapshot } from "@/services/version-history/version.types";
import type { AffectedConsumer } from "@/types/schemas/governance";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFieldSnapshot(overrides: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return {
    id: "field-1",
    name: "test_field",
    type: "string",
    precision: null,
    scale: null,
    nullable: true,
    isKey: false,
    fieldNumber: 1,
    description: "Test field",
    classification: null,
    aliases: [],
    decorators: {},
    sortOrder: 1,
    ...overrides,
  };
}

function makeClassification(
  changeType: ChangeClassification["changeType"] = "non-breaking"
): ChangeClassification {
  return {
    changeType,
    severity: changeType === "breaking" ? "high" : "low",
    reasons: [`Test reason`],
    perTarget: [
      {
        target: "bigquery",
        changeType,
        details: "BQ details",
      },
      {
        target: "avro",
        changeType,
        details: "Avro details",
      },
      {
        target: "openapi",
        changeType,
        details: "OpenAPI details",
      },
    ],
  };
}

function makeDiff(
  fields: DiffResult["fields"] = [],
  summary?: Partial<DiffResult["summary"]>
): DiffResult {
  const defaultSummary = {
    added: fields.filter((f) => f.changeType === "added").length,
    removed: fields.filter((f) => f.changeType === "removed").length,
    modified: fields.filter((f) => f.changeType === "modified").length,
    unchanged: fields.filter((f) => f.changeType === "unchanged").length,
  };

  return {
    fromVersion: 1,
    toVersion: 2,
    summary: { ...defaultSummary, ...summary },
    fields,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Impact Report Service", () => {
  describe("generateImpactReport", () => {
    it("generates report for non-breaking change (all targets compatible)", () => {
      const classification = makeClassification("non-breaking");
      const diff = makeDiff([
        {
          fieldName: "new_field",
          changeType: "added",
          versionB: makeFieldSnapshot({ name: "new_field", nullable: true }),
        },
      ]);

      const result = generateImpactReport(classification, diff, "Customer");
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.summary).toContain("Non-breaking");
      expect(result.data.summary).toContain("Customer");
      expect(result.data.perTarget).toHaveLength(3);
      expect(result.data.perTarget.every((pt) => pt.compatible)).toBe(true);
    });

    it("generates report for breaking change (mixed compatibility)", () => {
      const classification = makeClassification("breaking");
      const diff = makeDiff([
        {
          fieldName: "removed_field",
          changeType: "removed",
          versionA: makeFieldSnapshot({ name: "removed_field", nullable: false }),
        },
      ]);

      const result = generateImpactReport(classification, diff, "Order");
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.summary).toContain("Breaking");
      expect(result.data.perTarget.some((pt) => !pt.compatible)).toBe(true);
    });

    it("includes affected consumers when provided", () => {
      const consumers: AffectedConsumer[] = [
        {
          entityName: "Invoice",
          fieldName: "order_id",
          relationship: "FK",
          ownerEmail: "alice@example.com",
        },
      ];

      const result = generateImpactReport(
        makeClassification("breaking"),
        makeDiff([
          {
            fieldName: "id",
            changeType: "removed",
            versionA: makeFieldSnapshot({ name: "id" }),
          },
        ]),
        "Order",
        consumers
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.affectedConsumers).toHaveLength(1);
      expect(result.data.affectedConsumers[0].entityName).toBe("Invoice");
    });

    it("returns empty affected consumers when no references", () => {
      const result = generateImpactReport(
        makeClassification("non-breaking"),
        makeDiff([
          {
            fieldName: "f1",
            changeType: "added",
            versionB: makeFieldSnapshot({ name: "f1", nullable: true }),
          },
        ]),
        "Standalone"
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.affectedConsumers).toHaveLength(0);
    });

    it("generates migration artifacts summary for all three targets", () => {
      const result = generateImpactReport(
        makeClassification("non-breaking"),
        makeDiff([
          {
            fieldName: "f1",
            changeType: "added",
            versionB: makeFieldSnapshot({ name: "f1", nullable: true }),
          },
        ]),
        "Entity1"
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.migrationArtifactsSummary).toHaveProperty("bigquery");
      expect(result.data.migrationArtifactsSummary).toHaveProperty("avro");
      expect(result.data.migrationArtifactsSummary).toHaveProperty("openapi");
    });
  });

  describe("computeMigrationComplexity", () => {
    it("classifies add-only changes as trivial", () => {
      const diff = makeDiff([
        {
          fieldName: "f1",
          changeType: "added",
          versionB: makeFieldSnapshot({ name: "f1", nullable: true }),
        },
      ]);

      expect(computeMigrationComplexity(diff, "bigquery")).toBe("trivial");
    });

    it("classifies field removals as complex", () => {
      const diff = makeDiff([
        {
          fieldName: "f1",
          changeType: "removed",
          versionA: makeFieldSnapshot({ name: "f1" }),
        },
      ]);

      expect(computeMigrationComplexity(diff, "bigquery")).toBe("complex");
    });

    it("classifies type changes as moderate", () => {
      const diff = makeDiff([
        {
          fieldName: "f1",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "f1", type: "string" }),
          versionB: makeFieldSnapshot({ name: "f1", type: "int32" }),
          changedProperties: [
            {
              property: "type",
              category: "field",
              before: "string",
              after: "int32",
            },
          ],
        },
      ]);

      expect(computeMigrationComplexity(diff, "bigquery")).toBe("moderate");
    });

    it("classifies nullable→non-nullable as complex", () => {
      const diff = makeDiff([
        {
          fieldName: "f1",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "f1", nullable: true }),
          versionB: makeFieldSnapshot({ name: "f1", nullable: false }),
          changedProperties: [
            {
              property: "nullable",
              category: "field",
              before: true,
              after: false,
            },
          ],
        },
      ]);

      expect(computeMigrationComplexity(diff, "bigquery")).toBe("complex");
    });
  });
});
