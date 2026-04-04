import { describe, it, expect } from "vitest";
import {
  normalizeFieldList,
  compareFieldLists,
  determineDriftStatus,
} from "@/lib/drift/drift-comparator";
import type { ParsedField } from "@/lib/importers/types";
import type { NormalizedField } from "@/lib/drift/drift-comparator";

describe("Drift Comparator", () => {
  describe("normalizeFieldList", () => {
    it("sorts fields by name", () => {
      const fields: ParsedField[] = [
        {
          name: "zebra",
          type: "string",
          nullable: false,
          confidence: "high",
          originalType: "string",
        },
        {
          name: "alpha",
          type: "int32",
          nullable: true,
          confidence: "high",
          originalType: "int",
        },
      ];

      const normalized = normalizeFieldList(fields);
      expect(normalized[0].name).toBe("alpha");
      expect(normalized[1].name).toBe("zebra");
    });

    it("strips confidence and originalType", () => {
      const fields: ParsedField[] = [
        {
          name: "id",
          type: "string",
          nullable: false,
          confidence: "high",
          originalType: "string",
        },
      ];

      const normalized = normalizeFieldList(fields);
      expect(normalized[0]).toEqual({
        name: "id",
        type: "string",
        nullable: false,
        description: undefined,
        fieldNumber: undefined,
      });
    });
  });

  describe("compareFieldLists", () => {
    it("returns no differences for identical field lists (in-sync)", () => {
      const logical: NormalizedField[] = [
        { name: "id", type: "string", nullable: false },
        { name: "name", type: "string", nullable: true },
      ];
      const implementation: NormalizedField[] = [
        { name: "id", type: "string", nullable: false },
        { name: "name", type: "string", nullable: true },
      ];

      const diffs = compareFieldLists(logical, implementation);
      expect(diffs).toHaveLength(0);
    });

    it('detects field in logical but not implementation as "added"', () => {
      const logical: NormalizedField[] = [
        { name: "id", type: "string", nullable: false },
        { name: "email", type: "string", nullable: true },
      ];
      const implementation: NormalizedField[] = [
        { name: "id", type: "string", nullable: false },
      ];

      const diffs = compareFieldLists(logical, implementation);
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toMatchObject({
        fieldName: "email",
        type: "added",
        logicalValue: "string",
        implementationValue: null,
      });
    });

    it('detects field in implementation but not logical as "removed"', () => {
      const logical: NormalizedField[] = [
        { name: "id", type: "string", nullable: false },
      ];
      const implementation: NormalizedField[] = [
        { name: "id", type: "string", nullable: false },
        { name: "legacy_field", type: "int64", nullable: true },
      ];

      const diffs = compareFieldLists(logical, implementation);
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toMatchObject({
        fieldName: "legacy_field",
        type: "removed",
        logicalValue: null,
        implementationValue: "int64",
      });
    });

    it('detects type mismatch as "type-mismatch"', () => {
      const logical: NormalizedField[] = [
        { name: "age", type: "int64", nullable: false },
      ];
      const implementation: NormalizedField[] = [
        { name: "age", type: "string", nullable: false },
      ];

      const diffs = compareFieldLists(logical, implementation);
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toMatchObject({
        fieldName: "age",
        type: "type-mismatch",
        logicalValue: "int64",
        implementationValue: "string",
      });
    });

    it('detects nullability mismatch as "metadata-mismatch"', () => {
      const logical: NormalizedField[] = [
        { name: "email", type: "string", nullable: true },
      ];
      const implementation: NormalizedField[] = [
        { name: "email", type: "string", nullable: false },
      ];

      const diffs = compareFieldLists(logical, implementation);
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toMatchObject({
        fieldName: "email",
        type: "metadata-mismatch",
        logicalValue: "nullable=true",
        implementationValue: "nullable=false",
      });
    });

    it("detects multiple differences across multiple fields", () => {
      const logical: NormalizedField[] = [
        { name: "id", type: "string", nullable: false },
        { name: "name", type: "string", nullable: true },
        { name: "new_field", type: "int32", nullable: false },
      ];
      const implementation: NormalizedField[] = [
        { name: "id", type: "int64", nullable: false },
        { name: "name", type: "string", nullable: true },
        { name: "old_field", type: "boolean", nullable: true },
      ];

      const diffs = compareFieldLists(logical, implementation);
      expect(diffs.length).toBeGreaterThanOrEqual(3);

      const types = diffs.map((d) => d.type);
      expect(types).toContain("added"); // new_field
      expect(types).toContain("removed"); // old_field
      expect(types).toContain("type-mismatch"); // id: string vs int64
    });

    it("returns no differences for empty field lists", () => {
      const diffs = compareFieldLists([], []);
      expect(diffs).toHaveLength(0);
    });
  });

  describe("determineDriftStatus", () => {
    it('returns "in-sync" for empty differences', () => {
      expect(determineDriftStatus([])).toBe("in-sync");
    });

    it('returns "drifted" for non-empty differences', () => {
      expect(
        determineDriftStatus([
          {
            fieldName: "x",
            type: "added",
            logicalValue: "string",
            implementationValue: null,
          },
        ])
      ).toBe("drifted");
    });
  });
});
