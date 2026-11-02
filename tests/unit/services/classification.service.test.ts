import { describe, it, expect } from "vitest";

import { classifyFromDiff, classifyChanges } from "@/services/classification.service";
import type { DiffResult, DiffField, FieldSnapshot } from "@/services/version-history/version.types";

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

function makeDiffResult(fields: DiffField[]): DiffResult {
  return {
    fromVersion: 1,
    toVersion: 2,
    summary: {
      added: fields.filter((f) => f.changeType === "added").length,
      removed: fields.filter((f) => f.changeType === "removed").length,
      modified: fields.filter((f) => f.changeType === "modified").length,
      unchanged: fields.filter((f) => f.changeType === "unchanged").length,
    },
    fields,
  };
}

// ---------------------------------------------------------------------------
// Non-Breaking Change Rules
// ---------------------------------------------------------------------------

describe("Classification Service", () => {
  describe("Non-Breaking Changes", () => {
    it("classifies adding optional nullable field as non-breaking", () => {
      const diff = makeDiffResult([
        {
          fieldName: "email",
          changeType: "added",
          versionB: makeFieldSnapshot({ name: "email", nullable: true }),
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("non-breaking");
      expect(result.severity).toBe("low");
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toContain("optional");
    });

    it("classifies adding decorator/metadata as non-breaking", () => {
      const diff = makeDiffResult([
        {
          fieldName: "name",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "name", decorators: {} }),
          versionB: makeFieldSnapshot({
            name: "name",
            decorators: { format: "email" },
          }),
          changedProperties: [
            { property: "decorators", category: "decorators", before: {}, after: { format: "email" } },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("non-breaking");
      expect(result.severity).toBe("low");
    });

    it("classifies modifying description as non-breaking", () => {
      const diff = makeDiffResult([
        {
          fieldName: "name",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "name", description: "Old desc" }),
          versionB: makeFieldSnapshot({ name: "name", description: "New desc" }),
          changedProperties: [
            { property: "description", category: "field", before: "Old desc", after: "New desc" },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("non-breaking");
    });

    it("classifies adding an alias as non-breaking", () => {
      const diff = makeDiffResult([
        {
          fieldName: "name",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "name", aliases: [] }),
          versionB: makeFieldSnapshot({
            name: "name",
            aliases: ["full_name"],
          }),
          changedProperties: [
            { property: "aliases", category: "metadata", before: [], after: ["full_name"] },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("non-breaking");
    });
  });

  // ---------------------------------------------------------------------------
  // Breaking Change Rules
  // ---------------------------------------------------------------------------

  describe("Breaking Changes", () => {
    it("classifies removing a field as breaking (critical)", () => {
      const diff = makeDiffResult([
        {
          fieldName: "old_field",
          changeType: "removed",
          versionA: makeFieldSnapshot({ name: "old_field" }),
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("breaking");
      expect(result.severity).toBe("critical");
    });

    it("classifies changing field type as breaking (high)", () => {
      const diff = makeDiffResult([
        {
          fieldName: "amount",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "amount", type: "string" }),
          versionB: makeFieldSnapshot({ name: "amount", type: "int32" }),
          changedProperties: [
            { property: "type", category: "field", before: "string", after: "int32" },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("breaking");
      expect(result.severity).toBe("high");
    });

    it("classifies making nullable field non-nullable as breaking (high)", () => {
      const diff = makeDiffResult([
        {
          fieldName: "email",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "email", nullable: true }),
          versionB: makeFieldSnapshot({ name: "email", nullable: false }),
          changedProperties: [
            { property: "nullable", category: "field", before: true, after: false },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("breaking");
      expect(result.severity).toBe("high");
    });

    it("classifies renaming field without alias as breaking (high)", () => {
      const diff = makeDiffResult([
        {
          fieldName: "new_name",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "old_name", aliases: [] }),
          versionB: makeFieldSnapshot({ name: "new_name", aliases: [] }),
          changedProperties: [
            { property: "name", category: "field", before: "old_name", after: "new_name" },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("breaking");
      expect(result.severity).toBe("high");
    });

    it("classifies reducing precision as breaking (medium)", () => {
      const diff = makeDiffResult([
        {
          fieldName: "amount",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "amount", precision: 18 }),
          versionB: makeFieldSnapshot({ name: "amount", precision: 10 }),
          changedProperties: [
            { property: "precision", category: "field", before: 18, after: 10 },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("breaking");
      expect(result.severity).toBe("medium");
    });

    it("classifies reducing scale as breaking (medium)", () => {
      const diff = makeDiffResult([
        {
          fieldName: "amount",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "amount", scale: 6 }),
          versionB: makeFieldSnapshot({ name: "amount", scale: 2 }),
          changedProperties: [
            { property: "scale", category: "field", before: 6, after: 2 },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("breaking");
      expect(result.severity).toBe("medium");
    });

    it("classifies re-pointing a reference as breaking (high) in the core rules and in every target", () => {
      const diff = makeDiffResult([
        {
          fieldName: "customer",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "customer", type: "reference" }),
          versionB: makeFieldSnapshot({ name: "customer", type: "reference" }),
          changedProperties: [
            { property: "referenceTarget", category: "reference", before: "Customer", after: "Vendor" },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("breaking");
      expect(result.severity).toBe("high");
      expect(result.reasons).toEqual([
        'Re-pointed reference "customer" from "Customer" to "Vendor" — consumers and generated schemas now type it as another entity',
      ]);
      expect(result.perTarget.map((t) => [t.target, t.changeType])).toEqual([
        ["bigquery", "breaking"],
        ["avro", "breaking"],
        ["openapi", "breaking"],
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Classification Change Rules
  // ---------------------------------------------------------------------------

  describe("Classification Changes", () => {
    it("classifies changing classification level as classification-change (medium)", () => {
      const diff = makeDiffResult([
        {
          fieldName: "ssn",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "ssn", classification: "INTERNAL" }),
          versionB: makeFieldSnapshot({ name: "ssn", classification: "PII" }),
          changedProperties: [
            { property: "classification", category: "governance", before: "INTERNAL", after: "PII" },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("classification-change");
      expect(result.severity).toBe("medium");
    });

    it("detects classification change separately from structural changes", () => {
      // Only a classification change, no structural changes
      const diff = makeDiffResult([
        {
          fieldName: "email",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "email", classification: "PUBLIC" }),
          versionB: makeFieldSnapshot({ name: "email", classification: "SENSITIVE" }),
          changedProperties: [
            { property: "classification", category: "governance", before: "PUBLIC", after: "SENSITIVE" },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);
      expect(result.changeType).toBe("classification-change");
      // Not "breaking" — it's a governance concern, not structural
    });
  });

  // ---------------------------------------------------------------------------
  // Per-Target Classification
  // ---------------------------------------------------------------------------

  describe("Per-Target Classification", () => {
    it("same change classified differently for BigQuery vs Avro", () => {
      // Adding an optional nullable field: safe for all targets
      const diff = makeDiffResult([
        {
          fieldName: "new_opt",
          changeType: "added",
          versionB: makeFieldSnapshot({ name: "new_opt", nullable: true }),
        },
      ]);

      const result = classifyFromDiff(diff);
      const bq = result.perTarget.find((pt) => pt.target === "bigquery");
      const avro = result.perTarget.find((pt) => pt.target === "avro");

      expect(bq).toBeDefined();
      expect(avro).toBeDefined();
      expect(bq!.changeType).toBe("non-breaking");
      expect(avro!.changeType).toBe("non-breaking");
    });

    it("BigQuery ADD COLUMN = non-breaking while Avro field removal = breaking", () => {
      // One added optional + one removed required
      const diff = makeDiffResult([
        {
          fieldName: "new_field",
          changeType: "added",
          versionB: makeFieldSnapshot({ name: "new_field", nullable: true }),
        },
        {
          fieldName: "old_required",
          changeType: "removed",
          versionA: makeFieldSnapshot({
            name: "old_required",
            nullable: false,
          }),
        },
      ]);

      const result = classifyFromDiff(diff);

      // Both should be breaking overall due to field removal
      const bq = result.perTarget.find((pt) => pt.target === "bigquery");
      const avro = result.perTarget.find((pt) => pt.target === "avro");

      expect(bq!.changeType).toBe("breaking");
      expect(avro!.changeType).toBe("breaking");
      expect(result.changeType).toBe("breaking");
    });

    it("per-target divergence for type changes with Avro promotions", () => {
      // int → long is safe in Avro (promotion) but breaking in BigQuery
      const diff = makeDiffResult([
        {
          fieldName: "count",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "count", type: "int" }),
          versionB: makeFieldSnapshot({ name: "count", type: "long" }),
          changedProperties: [
            { property: "type", category: "field", before: "int", after: "long" },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);

      const avro = result.perTarget.find((pt) => pt.target === "avro");
      const bq = result.perTarget.find((pt) => pt.target === "bigquery");

      // Avro supports int→long promotion = non-breaking
      expect(avro!.changeType).toBe("non-breaking");
      // BigQuery requires CAST = breaking
      expect(bq!.changeType).toBe("breaking");
    });
  });

  // ---------------------------------------------------------------------------
  // Severity Rollup
  // ---------------------------------------------------------------------------

  describe("Severity Rollup", () => {
    it("overall severity is max of individual severities", () => {
      const diff = makeDiffResult([
        {
          fieldName: "opt_field",
          changeType: "added",
          versionB: makeFieldSnapshot({ name: "opt_field", nullable: true }),
        },
        {
          fieldName: "removed_field",
          changeType: "removed",
          versionA: makeFieldSnapshot({ name: "removed_field" }),
        },
      ]);

      const result = classifyFromDiff(diff);
      // low from added + critical from removed → overall critical
      expect(result.severity).toBe("critical");
    });
  });

  // ---------------------------------------------------------------------------
  // Integration-Style Test
  // ---------------------------------------------------------------------------

  describe("Complex Change Integration", () => {
    it("complex change produces multiple reasons and per-target breakdown", () => {
      const diff = makeDiffResult([
        // Add optional field (non-breaking)
        {
          fieldName: "new_field",
          changeType: "added",
          versionB: makeFieldSnapshot({ name: "new_field", nullable: true }),
        },
        // Modify type (breaking)
        {
          fieldName: "amount",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "amount", type: "string" }),
          versionB: makeFieldSnapshot({ name: "amount", type: "decimal" }),
          changedProperties: [
            { property: "type", category: "field", before: "string", after: "decimal" },
          ],
        },
        // Change classification (classification-change)
        {
          fieldName: "ssn",
          changeType: "modified",
          versionA: makeFieldSnapshot({ name: "ssn", classification: "INTERNAL" }),
          versionB: makeFieldSnapshot({ name: "ssn", classification: "PII" }),
          changedProperties: [
            { property: "classification", category: "governance", before: "INTERNAL", after: "PII" },
          ],
        },
      ]);

      const result = classifyFromDiff(diff);

      // Overall should be breaking (type change is worst)
      expect(result.changeType).toBe("breaking");

      // Should have multiple reasons
      expect(result.reasons.length).toBeGreaterThanOrEqual(3);

      // Should have per-target breakdown
      expect(result.perTarget).toHaveLength(3);

      // All three targets should be represented
      const targets = result.perTarget.map((pt) => pt.target).sort();
      expect(targets).toEqual(["avro", "bigquery", "openapi"]);

      // Type change makes all targets breaking
      expect(result.perTarget.every((pt) => pt.changeType === "breaking")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // classifyChanges wrapper
  // ---------------------------------------------------------------------------

  describe("classifyChanges (Result wrapper)", () => {
    it("returns success result for valid diff", () => {
      const diff = makeDiffResult([
        {
          fieldName: "f1",
          changeType: "added",
          versionB: makeFieldSnapshot({ name: "f1", nullable: true }),
        },
      ]);

      const result = classifyChanges(diff);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.changeType).toBe("non-breaking");
      }
    });
  });
});
