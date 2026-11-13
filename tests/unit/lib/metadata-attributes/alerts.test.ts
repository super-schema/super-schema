import { describe, expect, it } from "vitest";
import { metadataAttributeAlerts } from "@/lib/metadata-attributes/alerts";
import { generateEntityAlerts, type AlertFieldInput } from "@/lib/validation/entity-alerts";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

const entity = { description: "d", metadata: {} as Record<string, unknown> | null };

function def(over: Partial<MetadataAttributeDefinition>): MetadataAttributeDefinition {
  return {
    key: "x-data-category",
    label: "Data category",
    description: "",
    valueSchema: { type: "string", enum: ["ConsumerPersonal", "Intrinsic"] },
    targets: ["field"],
    scope: "schema",
    placement: "field",
    requiredWhen: "primitive",
    ...over,
  } as MetadataAttributeDefinition;
}

function field(over: Partial<AlertFieldInput>): AlertFieldInput {
  return { id: "f1", name: "email", type: "string", description: "x", classification: null, decorators: {}, ...over };
}

describe("metadataAttributeAlerts", () => {
  it("flags a primitive field missing a requiredWhen:primitive attribute", () => {
    const alerts = metadataAttributeAlerts(entity, [field({})], [def({})]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "warning", category: "field", fieldId: "f1", fieldName: "email" });
    expect(alerts[0].id).toContain("METADATA_ATTRIBUTE_MISSING");
    expect(alerts[0].description).toContain("x-data-category");
  });

  it("flags an array of primitives but not an entity-reference field", () => {
    const fields = [
      field({ id: "f1", name: "tags", type: "array", decorators: { arrayElementType: "string" } }),
      field({ id: "f2", name: "address", type: "reference", decorators: {} }),
    ];
    const alerts = metadataAttributeAlerts(entity, fields, [def({})]);
    expect(alerts.map((a) => a.fieldId)).toEqual(["f1"]);
  });

  it("does not flag a field that has the value", () => {
    const f = field({ decorators: { typespec: { extensions: { openapi: { "x-data-category": "Intrinsic" } } } } });
    expect(metadataAttributeAlerts(entity, [f], [def({})])).toEqual([]);
  });

  it("requiredWhen always on an entity target flags the entity when absent", () => {
    const alerts = metadataAttributeAlerts(entity, [], [def({ key: "x-owner-team", targets: ["entity"], requiredWhen: "always", valueSchema: { type: "string" } })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "warning", category: "entity" });
    expect(alerts[0].id).toContain("METADATA_ATTRIBUTE_MISSING");
    expect(alerts[0].fieldId).toBeUndefined();
  });

  it("does not raise field alerts for a definition that does not target field", () => {
    const d = def({ targets: ["entity"], requiredWhen: "always" });
    const e = { description: "d", metadata: { custom: { extensions: { "x-data-category": "Intrinsic" } } } };
    expect(metadataAttributeAlerts(e, [field({})], [d])).toEqual([]);
  });

  it("reports an invalid stored value without touching it", () => {
    const decorators = { typespec: { extensions: { openapi: { "x-data-category": "Partner" } } } };
    const snapshot = JSON.parse(JSON.stringify(decorators));
    const alerts = metadataAttributeAlerts(entity, [field({ decorators })], [def({ requiredWhen: "never" })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toContain("METADATA_ATTRIBUTE_INVALID");
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].description).toContain("x-data-category");
    expect(alerts[0].description).toContain("Partner");
    expect(decorators).toEqual(snapshot);
  });

  it("validates an entity value", () => {
    const e = { description: "d", metadata: { custom: { extensions: { "x-owner-team": 5 } } } };
    const alerts = metadataAttributeAlerts(e, [], [def({ key: "x-owner-team", targets: ["entity"], requiredWhen: "never", valueSchema: { type: "string" } })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ category: "entity" });
    expect(alerts[0].id).toContain("METADATA_ATTRIBUTE_INVALID");
  });

  it("generateEntityAlerts is unchanged without definitions and appends attribute alerts with them", () => {
    const fields = [field({})];
    const base = generateEntityAlerts(entity, fields);
    expect(generateEntityAlerts(entity, fields, null, undefined)).toEqual(base);
    expect(generateEntityAlerts(entity, fields, null, [])).toEqual(base);
    const withDefs = generateEntityAlerts(entity, fields, null, [def({})]);
    expect(withDefs.slice(0, base.length)).toEqual(base);
    expect(withDefs.length).toBe(base.length + 1);
  });
});
