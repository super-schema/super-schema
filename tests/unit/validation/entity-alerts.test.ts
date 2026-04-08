import { describe, it, expect } from "vitest";
import {
  generateEntityAlerts,
  generateTargetDriftAlerts,
  DEFAULT_COMPLETENESS_REQUIREMENTS,
  type AlertEntityInput,
  type AlertFieldInput,
} from "@/lib/validation/entity-alerts";
import type { CompletenessRequirements } from "@/types/schemas/domain-policy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<AlertEntityInput> = {}): AlertEntityInput {
  return {
    description: "A well-described entity",
    metadata: {
      owner: "alice@example.com",
      tags: ["finance", "core"],
      retentionPolicy: { strategy: "age-based", period: 90, periodUnit: "days", action: "delete" },
    },
    ...overrides,
  };
}

function makeField(overrides: Partial<AlertFieldInput> = {}): AlertFieldInput {
  return {
    id: "field-1",
    name: "user_id",
    description: "The unique user identifier",
    classification: "INTERNAL",
    ...overrides,
  };
}

const ALL_ENABLED: CompletenessRequirements = {
  ownerRequired: { enabled: true, severity: "error" },
  descriptionRequired: { enabled: true, severity: "error" },
  tagsMinCount: { enabled: true, severity: "warning", params: { minCount: 2 } },
  retentionPolicyRequired: { enabled: true, severity: "error" },
  fieldDescriptionRequired: { enabled: true, severity: "warning" },
  fieldClassificationExplicit: { enabled: true, severity: "warning" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateEntityAlerts", () => {
  it("returns zero alerts for a fully complete entity", () => {
    const entity = makeEntity();
    const fields = [makeField()];
    const alerts = generateEntityAlerts(entity, fields, ALL_ENABLED);
    expect(alerts).toHaveLength(0);
  });

  it("generates owner alert when owner is missing", () => {
    const entity = makeEntity({ metadata: { owner: "", tags: ["a"], retentionPolicy: {} } });
    const alerts = generateEntityAlerts(entity, [], ALL_ENABLED);
    const ownerAlert = alerts.find((a) => a.id === "entity-owner");
    expect(ownerAlert).toBeDefined();
    expect(ownerAlert!.severity).toBe("error");
    expect(ownerAlert!.category).toBe("entity");
    expect(ownerAlert!.action).toBe("Set owner");
  });

  it("generates owner alert when metadata is null", () => {
    const entity = makeEntity({ metadata: null });
    const alerts = generateEntityAlerts(entity, [], ALL_ENABLED);
    expect(alerts.find((a) => a.id === "entity-owner")).toBeDefined();
  });

  it("generates description alert when description is empty", () => {
    const entity = makeEntity({ description: "" });
    const alerts = generateEntityAlerts(entity, [], ALL_ENABLED);
    const descAlert = alerts.find((a) => a.id === "entity-description");
    expect(descAlert).toBeDefined();
    expect(descAlert!.severity).toBe("error");
    expect(descAlert!.action).toBe("Add description");
  });

  it("generates description alert when below minLength", () => {
    const template: CompletenessRequirements = {
      descriptionRequired: { enabled: true, severity: "warning", params: { minLength: 20 } },
    };
    const entity = makeEntity({ description: "Short" });
    const alerts = generateEntityAlerts(entity, [], template);
    const descAlert = alerts.find((a) => a.id === "entity-description");
    expect(descAlert).toBeDefined();
    expect(descAlert!.description).toContain("at least 20 characters");
  });

  it("generates tags alert when tags count is below minimum", () => {
    const entity = makeEntity({
      metadata: { owner: "bob", tags: ["one"], retentionPolicy: {} },
    });
    const alerts = generateEntityAlerts(entity, [], ALL_ENABLED);
    const tagsAlert = alerts.find((a) => a.id === "entity-tags");
    expect(tagsAlert).toBeDefined();
    expect(tagsAlert!.severity).toBe("warning");
    expect(tagsAlert!.description).toContain("1 tag");
    expect(tagsAlert!.description).toContain("at least 2");
  });

  it("generates retention policy alert when not set", () => {
    const entity = makeEntity({ metadata: { owner: "bob", tags: ["a", "b"] } });
    const alerts = generateEntityAlerts(entity, [], ALL_ENABLED);
    const retAlert = alerts.find((a) => a.id === "entity-retention");
    expect(retAlert).toBeDefined();
    expect(retAlert!.severity).toBe("error");
    expect(retAlert!.action).toBe("Set retention policy");
  });

  it("generates per-field alerts for missing descriptions", () => {
    const entity = makeEntity();
    const fields = [
      makeField({ id: "f1", name: "email", description: "" }),
      makeField({ id: "f2", name: "name", description: "Full name" }),
      makeField({ id: "f3", name: "phone", description: "" }),
    ];
    const alerts = generateEntityAlerts(entity, fields, ALL_ENABLED);
    const fieldDescAlerts = alerts.filter((a) => a.id.startsWith("field-desc-"));
    expect(fieldDescAlerts).toHaveLength(2);
    expect(fieldDescAlerts[0].fieldId).toBe("f1");
    expect(fieldDescAlerts[0].fieldName).toBe("email");
    expect(fieldDescAlerts[1].fieldId).toBe("f3");
  });

  it("generates per-field alerts for null classification", () => {
    const entity = makeEntity();
    const fields = [
      makeField({ id: "f1", name: "email", classification: null }),
      makeField({ id: "f2", name: "name", classification: "PII" }),
    ];
    const alerts = generateEntityAlerts(entity, fields, ALL_ENABLED);
    const classAlerts = alerts.filter((a) => a.id.startsWith("field-class-"));
    expect(classAlerts).toHaveLength(1);
    expect(classAlerts[0].fieldName).toBe("email");
    expect(classAlerts[0].action).toBe("Set classification");
  });

  it("does not generate alerts for disabled requirements", () => {
    const template: CompletenessRequirements = {
      ownerRequired: { enabled: false, severity: "error" },
      descriptionRequired: { enabled: false, severity: "error" },
      tagsMinCount: { enabled: false, severity: "warning" },
      retentionPolicyRequired: { enabled: false, severity: "error" },
      fieldDescriptionRequired: { enabled: false, severity: "warning" },
      fieldClassificationExplicit: { enabled: false, severity: "warning" },
    };
    const entity = makeEntity({ description: "", metadata: null });
    const fields = [makeField({ description: "", classification: null })];
    const alerts = generateEntityAlerts(entity, fields, template);
    expect(alerts).toHaveLength(0);
  });

  it("uses default template when no template is provided", () => {
    const entity = makeEntity({ description: "", metadata: null });
    const fields = [makeField({ description: "", classification: null })];
    const alerts = generateEntityAlerts(entity, fields);
    // Default enables: owner(warn), description(warn), retention(warn), fieldDescription(warn)
    // Default disables: tagsMinCount, fieldClassificationExplicit
    expect(alerts.length).toBeGreaterThanOrEqual(4); // owner + desc + retention + 1 field desc
    expect(alerts.every((a) => a.id !== "entity-tags")).toBe(true);
    expect(alerts.every((a) => !a.id.startsWith("field-class-"))).toBe(true);
  });

  it("uses null template to fall back to defaults", () => {
    const entity = makeEntity({ description: "", metadata: null });
    const alerts = generateEntityAlerts(entity, [], null);
    expect(alerts.length).toBeGreaterThanOrEqual(3); // owner + desc + retention
  });

  it("respects severity levels — error vs warning", () => {
    const template: CompletenessRequirements = {
      ownerRequired: { enabled: true, severity: "error" },
      descriptionRequired: { enabled: true, severity: "warning" },
    };
    const entity = makeEntity({ description: "", metadata: null });
    const alerts = generateEntityAlerts(entity, [], template);
    const ownerAlert = alerts.find((a) => a.id === "entity-owner");
    const descAlert = alerts.find((a) => a.id === "entity-description");
    expect(ownerAlert!.severity).toBe("error");
    expect(descAlert!.severity).toBe("warning");
  });

  it("produces stable IDs for React keys", () => {
    const entity = makeEntity({ metadata: null, description: "" });
    const fields = [
      makeField({ id: "abc-123", name: "email", description: "", classification: null }),
    ];
    const alerts = generateEntityAlerts(entity, fields, ALL_ENABLED);
    expect(alerts.map((a) => a.id)).toContain("entity-owner");
    expect(alerts.map((a) => a.id)).toContain("field-desc-abc-123");
    expect(alerts.map((a) => a.id)).toContain("field-class-abc-123");
  });
});

describe("generateTargetDriftAlerts", () => {
  it("surfaces persisted field overrides as target alerts", () => {
    const entity = makeEntity({
      version: 3,
      metadata: {
        schemaTargetTypeOverrides: {
          spanner: {
            "field-1": {
              fieldId: "field-1",
              fieldName: "user_id",
              sourceType: "string",
              target: "spanner",
              defaultMappedType: "STRING(MAX)",
              mappedType: "STRING(36)",
              createdAt: "2026-04-07T10:00:00.000Z",
              updatedAt: "2026-04-07T10:00:00.000Z",
              comment:
                "SUPER SCHEMA TYPE OVERRIDE: logical string defaulted to STRING(MAX); user selected STRING(36).",
            },
          },
        },
        schemaVersions: {
          spanner: [
            {
              version: 1,
              entityVersion: 2,
            },
          ],
        },
      },
    });

    const alerts = generateTargetDriftAlerts(entity, [
      makeField({
        id: "field-1",
        name: "user_id",
        type: "string",
        nullable: false,
      }),
    ]);

    expect(alerts.map((alert) => alert.id)).toContain("target-spanner-overrides");
    expect(alerts.map((alert) => alert.id)).toContain("target-spanner-behind");
  });

  it("marks stale target overrides as errors when the source field changed", () => {
    const entity = makeEntity({
      metadata: {
        schemaTargetTypeOverrides: {
          postgresql: {
            "field-1": {
              fieldId: "field-1",
              fieldName: "user_id",
              sourceType: "string",
              target: "postgresql",
              defaultMappedType: "text",
              mappedType: "uuid",
              createdAt: "2026-04-07T10:00:00.000Z",
              updatedAt: "2026-04-07T10:00:00.000Z",
              comment:
                "SUPER SCHEMA TYPE OVERRIDE: logical string defaulted to text; user selected uuid.",
            },
          },
        },
      },
    });

    const alerts = generateTargetDriftAlerts(entity, [
      makeField({
        id: "field-1",
        name: "user_id",
        type: "uuid",
      }),
    ]);

    const staleAlert = alerts.find((alert) => alert.id === "target-postgresql-stale");
    expect(staleAlert).toBeDefined();
    expect(staleAlert?.severity).toBe("error");
    expect(staleAlert?.category).toBe("target");
  });
});
