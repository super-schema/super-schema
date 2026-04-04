import { describe, it, expect } from "vitest";
import { detectDrift, detectDriftForMultiple } from "@/services/drift.service";
import type { DetectDriftInput } from "@/services/drift.service";

describe("Drift Service", () => {
  const avroContent = JSON.stringify({
    type: "record",
    name: "User",
    fields: [
      { name: "id", type: "string" },
      { name: "name", type: "string" },
      { name: "age", type: "int" },
    ],
  });

  describe("detectDrift", () => {
    it('returns "unknown" for entity without importedFrom metadata', () => {
      const input: DetectDriftInput = {
        entityId: "ent-1",
        entityName: "User",
        importedFrom: null,
        currentFields: [
          {
            name: "id",
            type: "string",
            nullable: false,
            confidence: "high",
            originalType: "string",
          },
        ],
        emissionTargets: [
          { targetFormat: "avro", emittedOutput: null },
        ],
      };

      const result = detectDrift(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.targets[0].driftStatus).toBe("unknown");
    });

    it("detects in-sync when current fields match imported fields", () => {
      const input: DetectDriftInput = {
        entityId: "ent-1",
        entityName: "User",
        importedFrom: {
          format: "avro",
          originalContent: avroContent,
        },
        currentFields: [
          {
            name: "id",
            type: "string",
            nullable: false,
            confidence: "high",
            originalType: "string",
          },
          {
            name: "name",
            type: "string",
            nullable: false,
            confidence: "high",
            originalType: "string",
          },
          {
            name: "age",
            type: "int32",
            nullable: false,
            confidence: "high",
            originalType: "int",
          },
        ],
      };

      const result = detectDrift(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.targets[0].driftStatus).toBe("in-sync");
    });

    it("detects drift when a field has been added", () => {
      const input: DetectDriftInput = {
        entityId: "ent-1",
        entityName: "User",
        importedFrom: {
          format: "avro",
          originalContent: avroContent,
        },
        currentFields: [
          {
            name: "id",
            type: "string",
            nullable: false,
            confidence: "high",
            originalType: "string",
          },
          {
            name: "name",
            type: "string",
            nullable: false,
            confidence: "high",
            originalType: "string",
          },
          {
            name: "age",
            type: "int32",
            nullable: false,
            confidence: "high",
            originalType: "int",
          },
          {
            name: "email",
            type: "string",
            nullable: true,
            confidence: "high",
            originalType: "string",
          },
        ],
      };

      const result = detectDrift(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.targets[0].driftStatus).toBe("drifted");
      expect(
        result.data.targets[0].differences.some(
          (d) => d.fieldName === "email" && d.type === "added"
        )
      ).toBe(true);
    });

    it("detects drift when a field has been removed", () => {
      const input: DetectDriftInput = {
        entityId: "ent-1",
        entityName: "User",
        importedFrom: {
          format: "avro",
          originalContent: avroContent,
        },
        currentFields: [
          {
            name: "id",
            type: "string",
            nullable: false,
            confidence: "high",
            originalType: "string",
          },
          // name and age removed
        ],
      };

      const result = detectDrift(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.targets[0].driftStatus).toBe("drifted");
      const removedFields = result.data.targets[0].differences.filter(
        (d) => d.type === "removed"
      );
      expect(removedFields.length).toBeGreaterThanOrEqual(1);
    });

    it("detects type mismatch drift", () => {
      const input: DetectDriftInput = {
        entityId: "ent-1",
        entityName: "User",
        importedFrom: {
          format: "avro",
          originalContent: avroContent,
        },
        currentFields: [
          {
            name: "id",
            type: "string",
            nullable: false,
            confidence: "high",
            originalType: "string",
          },
          {
            name: "name",
            type: "string",
            nullable: false,
            confidence: "high",
            originalType: "string",
          },
          {
            name: "age",
            type: "string", // Changed from int32
            nullable: false,
            confidence: "high",
            originalType: "string",
          },
        ],
      };

      const result = detectDrift(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.targets[0].driftStatus).toBe("drifted");
      expect(
        result.data.targets[0].differences.some(
          (d) => d.fieldName === "age" && d.type === "type-mismatch"
        )
      ).toBe(true);
    });

    it("handles emission targets with emitted output", () => {
      const emittedAvro = JSON.stringify({
        type: "record",
        name: "User",
        namespace: "com.superschema.test",
        fields: [
          { name: "id", type: "string" },
          { name: "name", type: "string" },
          { name: "age", type: "int" },
          { name: "email", type: ["null", "string"] }, // extra field
        ],
      });

      const input: DetectDriftInput = {
        entityId: "ent-1",
        entityName: "User",
        importedFrom: {
          format: "avro",
          originalContent: avroContent,
        },
        currentFields: [],
        emissionTargets: [
          { targetFormat: "avro", emittedOutput: emittedAvro },
        ],
      };

      const result = detectDrift(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.targets[0].targetFormat).toBe("avro");
      expect(result.data.targets[0].driftStatus).toBe("drifted");
    });

    it('returns "unknown" for emission target without output', () => {
      const input: DetectDriftInput = {
        entityId: "ent-1",
        entityName: "User",
        importedFrom: {
          format: "avro",
          originalContent: avroContent,
        },
        currentFields: [],
        emissionTargets: [
          { targetFormat: "bigquery-ddl", emittedOutput: null },
        ],
      };

      const result = detectDrift(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.targets[0].driftStatus).toBe("unknown");
    });
  });

  describe("detectDriftForMultiple", () => {
    it("processes multiple entities and returns reports", () => {
      const inputs: DetectDriftInput[] = [
        {
          entityId: "ent-1",
          entityName: "User",
          importedFrom: { format: "avro", originalContent: avroContent },
          currentFields: [
            {
              name: "id",
              type: "string",
              nullable: false,
              confidence: "high",
              originalType: "string",
            },
          ],
        },
        {
          entityId: "ent-2",
          entityName: "Order",
          importedFrom: null,
          currentFields: [],
        },
      ];

      const result = detectDriftForMultiple(inputs);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).toHaveLength(2);
      expect(result.data[0].entityId).toBe("ent-1");
      expect(result.data[1].entityId).toBe("ent-2");
    });
  });
});
