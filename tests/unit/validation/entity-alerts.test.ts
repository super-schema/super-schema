import { afterEach, describe, it, expect, vi } from "vitest";
import {
  generateEntityAlerts,
  generateReferenceStalenessAlerts,
  generateTargetDriftAlerts,
  DEFAULT_COMPLETENESS_REQUIREMENTS,
  type AlertEntityInput,
  type AlertFieldInput,
} from "@/lib/validation/entity-alerts";
import type { CompletenessRequirements } from "@/types/schemas/domain-policy";

// Which targets APPLY a stored override to what they generate (`supportsFieldOverrides`): none does today, so a test of the alerts for
// stored overrides says which target it pretends offers them.
const offering = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/schema-targets/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/schema-targets/catalog")>();
  return {
    ...actual,
    getSchemaTargetDefinition: (key: string) => {
      const definition = actual.getSchemaTargetDefinition(key);
      return definition && offering.has(key) ? { ...definition, supportsFieldOverrides: true } : definition;
    },
  };
});
afterEach(() => offering.clear());

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
  it("says nothing about stored overrides of a target whose generation does not apply them (the stored data stays untouched)", () => {
    const stored = {
      "field-1": {
        fieldId: "field-1",
        fieldName: "user_id",
        sourceType: "string",
        defaultMappedType: "STRING(MAX)",
        mappedType: "STRING(36)",
        createdAt: "2026-04-07T10:00:00.000Z",
        updatedAt: "2026-04-07T10:00:00.000Z",
        comment: "SUPER SCHEMA TYPE OVERRIDE: logical string defaulted to STRING(MAX); user selected STRING(36).",
      },
    };
    const entity = makeEntity({
      version: 3,
      metadata: {
        schemaTargetTypeOverrides: {
          spanner: { "field-1": { ...stored["field-1"], target: "spanner" } },
          bigquery: { "field-1": { ...stored["field-1"], target: "bigquery" } },
          postgresql: { "field-1": { ...stored["field-1"], target: "postgresql", defaultMappedType: "text", mappedType: "uuid" } },
        },
        schemaVersions: { spanner: [{ version: 1, entityVersion: 2 }] },
      },
    });
    const alerts = generateTargetDriftAlerts(entity, [makeField({ id: "field-1", name: "user_id", type: "string", nullable: false })]);
    expect(alerts).toEqual([]);
    // Data untouched: the stored overrides are still on the entity.
    expect(Object.keys((entity.metadata as { schemaTargetTypeOverrides: object }).schemaTargetTypeOverrides)).toEqual(["spanner", "bigquery", "postgresql"]);
  });

  it("surfaces persisted field overrides as target alerts (for a target that applies them)", () => {
    offering.add("spanner");
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
    offering.add("postgresql");
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

describe("unresolved references alert", () => {
  const dangling = (id: string, ref: string, element = false): AlertFieldInput =>
    makeField({ id, name: id, decorators: { danglingRef: { ref, ...(element ? { element: true } : {}) } } });

  it("lists each distinct raw reference once and says the entity stays DRAFT", () => {
    const alerts = generateEntityAlerts(
      makeEntity(),
      [makeField(), dangling("created_time", "common/date_time.json"), dangling("user_links", "user_links.json", true), dangling("again", "user_links.json")],
    );
    const alert = alerts.find((a) => a.id === "entity-unresolved-references");
    expect(alert).toMatchObject({ severity: "warning", category: "entity" });
    expect(alert?.title).toBe("2 unresolved references: common/date_time.json, user_links.json");
    expect(alert?.description).toContain("DRAFT");
  });

  it("is absent without a dangling field, and singular for one", () => {
    expect(generateEntityAlerts(makeEntity(), [makeField()]).some((a) => a.id === "entity-unresolved-references")).toBe(false);
    const one = generateEntityAlerts(makeEntity(), [dangling("a", "a.json")]).find((a) => a.id === "entity-unresolved-references");
    expect(one?.title).toBe("1 unresolved reference: a.json");
  });
});

describe("stale references alert (Task 8)", () => {
  const stale = (entity: string, recorded: string, latest: string) => ({
    ref: { entityId: `id-${entity}`, domain: "Sales", product: "Orders", entity },
    recorded,
    latest,
  });

  it("is absent when nothing is stale", () => {
    expect(generateReferenceStalenessAlerts([])).toEqual([]);
  });

  it("names the entity, the version recorded and the one published since, and says how to fix it", () => {
    const alerts = generateReferenceStalenessAlerts([stale("Customer", "1.0", "1.2")]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: "entity-stale-references", severity: "warning", category: "entity", action: "Review references" });
    expect(alerts[0].title).toBe("1 referenced entity has a newer published version: Customer 1.0 to 1.2");
    expect(alerts[0].description).toContain("Publish this entity again");
    expect(alerts[0].description).toMatch(/pin/i);
  });

  it("lists several in the given order, plural", () => {
    const alerts = generateReferenceStalenessAlerts([stale("Customer", "1.0", "1.2"), stale("Address", "2.0", "3.0")]);
    expect(alerts[0].title).toBe("2 referenced entities have a newer published version: Customer 1.0 to 1.2, Address 2.0 to 3.0");
  });

  it("names at most five, then +N more", () => {
    const many = Array.from({ length: 8 }, (_, i) => stale(`E${i}`, "1.0", "1.1"));
    const [alert] = generateReferenceStalenessAlerts(many);
    expect(alert.title).toBe(
      "8 referenced entities have a newer published version: E0 1.0 to 1.1, E1 1.0 to 1.1, E2 1.0 to 1.1, E3 1.0 to 1.1, E4 1.0 to 1.1 +3 more"
    );
  });

  it("is a separate list from the completeness alerts: generateEntityAlerts never reports it", () => {
    expect(generateEntityAlerts(makeEntity(), [makeField()]).some((a) => a.id === "entity-stale-references")).toBe(false);
  });
});

describe("unresolved references alert: bounded title", () => {
  it("names at most five distinct references, then +N more", () => {
    const fields: AlertFieldInput[] = Array.from({ length: 8 }, (_, i) =>
      makeField({ id: `f${i}`, name: `f${i}`, type: "reference", decorators: { danglingRef: { ref: `r${i}.json` } } }),
    );
    const alert = generateEntityAlerts(makeEntity(), fields).find((a) => a.id === "entity-unresolved-references");
    expect(alert?.title).toBe("8 unresolved references: r0.json, r1.json, r2.json, r3.json, r4.json +3 more");
  });

  it("ignores a stale marker on a field that is no longer a reference", () => {
    const stale = makeField({ id: "s", name: "s", type: "string", decorators: { danglingRef: { ref: "x.json" } } });
    expect(generateEntityAlerts(makeEntity(), [stale]).some((a) => a.id === "entity-unresolved-references")).toBe(false);
  });
});
