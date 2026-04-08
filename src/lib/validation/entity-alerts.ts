/**
 * Entity Alerts — pure-function alert generation engine.
 *
 * Compares entity + field state against domain completeness requirements
 * and returns a list of actionable alerts. No side effects, no DB access.
 */

import type { CompletenessRequirements, CompletenessRequirement } from "@/types/schemas/domain-policy";
import {
  buildSchemaTargetFieldMappings,
  parseSchemaTargetTypeOverrides,
  toFieldOverridePolicies,
} from "@/lib/schema-targets/field-type-overrides";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityAlert {
  id: string;
  severity: "error" | "warning";
  category: "entity" | "field" | "target";
  title: string;
  description: string;
  fieldId?: string;
  fieldName?: string;
  action: string;
  targetKey?: string;
}

export interface AlertEntityInput {
  description: string;
  metadata: Record<string, unknown> | null;
  version?: number;
}

export interface AlertFieldInput {
  id: string;
  name: string;
  type?: string;
  precision?: number | null;
  scale?: number | null;
  nullable?: boolean;
  isKey?: boolean;
  description: string;
  classification: string | null;
  aliases?: string[];
  decorators?: Record<string, unknown>;
  sortOrder?: number;
  fieldNumber?: number | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_COMPLETENESS_REQUIREMENTS: CompletenessRequirements = {
  ownerRequired: { enabled: true, severity: "warning" },
  descriptionRequired: { enabled: true, severity: "warning" },
  tagsMinCount: { enabled: false, severity: "warning", params: { minCount: 1 } },
  retentionPolicyRequired: { enabled: true, severity: "warning" },
  fieldDescriptionRequired: { enabled: true, severity: "warning" },
  fieldClassificationExplicit: { enabled: false, severity: "warning" },
};

// ---------------------------------------------------------------------------
// Alert generator
// ---------------------------------------------------------------------------

function req(
  requirements: CompletenessRequirements,
  key: keyof CompletenessRequirements
): CompletenessRequirement | undefined {
  return requirements[key];
}

function isEnabled(r: CompletenessRequirement | undefined): r is CompletenessRequirement {
  return !!r && r.enabled;
}

export function generateEntityAlerts(
  entity: AlertEntityInput,
  fields: AlertFieldInput[],
  template?: CompletenessRequirements | null
): EntityAlert[] {
  const requirements = template ?? DEFAULT_COMPLETENESS_REQUIREMENTS;
  const alerts: EntityAlert[] = [];

  const meta = (entity.metadata ?? {}) as Record<string, unknown>;
  const owner = (meta.owner as string) ?? "";
  const tags = (meta.tags as string[]) ?? [];
  const retentionPolicy = meta.retentionPolicy;

  // --- Entity-level checks ---

  // Owner required
  const ownerReq = req(requirements, "ownerRequired");
  if (isEnabled(ownerReq) && !owner.trim()) {
    alerts.push({
      id: "entity-owner",
      severity: ownerReq.severity,
      category: "entity",
      title: "Owner not set",
      description: "This entity has no owner assigned. Set an owner to establish accountability.",
      action: "Set owner",
    });
  }

  // Description required
  const descReq = req(requirements, "descriptionRequired");
  if (isEnabled(descReq)) {
    const minLength = (descReq.params?.minLength as number) ?? 1;
    if (!entity.description || entity.description.trim().length < minLength) {
      alerts.push({
        id: "entity-description",
        severity: descReq.severity,
        category: "entity",
        title: "Description missing",
        description:
          minLength > 1
            ? `Entity description must be at least ${minLength} characters.`
            : "Add a description to help others understand this entity.",
        action: "Add description",
      });
    }
  }

  // Tags min count
  const tagsReq = req(requirements, "tagsMinCount");
  if (isEnabled(tagsReq)) {
    const minCount = (tagsReq.params?.minCount as number) ?? 1;
    if (tags.length < minCount) {
      alerts.push({
        id: "entity-tags",
        severity: tagsReq.severity,
        category: "entity",
        title: "Not enough tags",
        description: `This entity has ${tags.length} tag${tags.length !== 1 ? "s" : ""} but requires at least ${minCount}.`,
        action: "Add tags",
      });
    }
  }

  // Retention policy required
  const retentionReq = req(requirements, "retentionPolicyRequired");
  if (isEnabled(retentionReq) && !retentionPolicy) {
    alerts.push({
      id: "entity-retention",
      severity: retentionReq.severity,
      category: "entity",
      title: "No retention policy",
      description: "A retention policy is required to define how long data should be kept.",
      action: "Set retention policy",
    });
  }

  // --- Field-level checks ---

  // Field descriptions required
  const fieldDescReq = req(requirements, "fieldDescriptionRequired");
  if (isEnabled(fieldDescReq)) {
    for (const field of fields) {
      if (!field.description || !field.description.trim()) {
        alerts.push({
          id: `field-desc-${field.id}`,
          severity: fieldDescReq.severity,
          category: "field",
          title: `Field "${field.name}" has no description`,
          description: "Add a description to document this field's purpose and contents.",
          fieldId: field.id,
          fieldName: field.name,
          action: "Edit field",
        });
      }
    }
  }

  // Field classification explicit
  const fieldClassReq = req(requirements, "fieldClassificationExplicit");
  if (isEnabled(fieldClassReq)) {
    for (const field of fields) {
      if (!field.classification) {
        alerts.push({
          id: `field-class-${field.id}`,
          severity: fieldClassReq.severity,
          category: "field",
          title: `Field "${field.name}" has no classification`,
          description: "Set an explicit data classification (e.g., PII, INTERNAL, PUBLIC).",
          fieldId: field.id,
          fieldName: field.name,
          action: "Set classification",
        });
      }
    }
  }

  return alerts;
}

export function generateTargetDriftAlerts(
  entity: AlertEntityInput,
  fields: AlertFieldInput[]
): EntityAlert[] {
  const meta = (entity.metadata ?? {}) as Record<string, unknown>;
  const overrides = parseSchemaTargetTypeOverrides(meta.schemaTargetTypeOverrides);
  const schemaVersions =
    (meta.schemaVersions as Record<string, Array<{ entityVersion?: number }>>) ?? {};

  const alerts: EntityAlert[] = [];
  const normalizedFields = fields.map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type ?? "string",
    precision: field.precision ?? null,
    scale: field.scale ?? null,
    nullable: field.nullable ?? true,
    isKey: field.isKey ?? false,
    fieldNumber: field.fieldNumber ?? null,
    description: field.description,
    classification: field.classification,
    aliases: field.aliases ?? [],
    decorators: field.decorators ?? {},
    sortOrder: field.sortOrder ?? 0,
  }));

  for (const target of Object.keys(overrides)) {
    const targetRows = buildSchemaTargetFieldMappings(
      normalizedFields,
      target,
      toFieldOverridePolicies(overrides, target),
      overrides,
      "target-alerts"
    );
    const activeOverrides = targetRows.filter((row) => row.overrideSource === "field");
    const staleOverrides = targetRows.filter((row) => row.isStale);

    if (activeOverrides.length === 0 && staleOverrides.length === 0) {
      continue;
    }

    const targetLabel = getSchemaTargetDefinition(target)?.displayName ?? target;
    if (activeOverrides.length > 0) {
      alerts.push({
        id: `target-${target}-overrides`,
        severity: "warning",
        category: "target",
        targetKey: target,
        title: `${targetLabel} uses persisted field overrides`,
        description: `${activeOverrides.length} field override${activeOverrides.length !== 1 ? "s" : ""} intentionally diverge from the default ${targetLabel} mapping.`,
        action: "Review target",
      });
    }

    if (staleOverrides.length > 0) {
      alerts.push({
        id: `target-${target}-stale`,
        severity: "error",
        category: "target",
        targetKey: target,
        title: `${targetLabel} overrides are stale`,
        description: `${staleOverrides.length} override${staleOverrides.length !== 1 ? "s" : ""} no longer match the current logical field type or default mapping.`,
        action: "Review target",
      });
    }

    const latestVersion = schemaVersions[target]?.[0];
    if (
      entity.version != null &&
      latestVersion?.entityVersion != null &&
      latestVersion.entityVersion < entity.version
    ) {
      alerts.push({
        id: `target-${target}-behind`,
        severity: "warning",
        category: "target",
        targetKey: target,
        title: `${targetLabel} needs regeneration`,
        description: `The latest generated ${targetLabel} version is based on entity v${latestVersion.entityVersion} while the entity is now at v${entity.version}. Persisted overrides will be kept, but the target is behind.`,
        action: "Review target",
      });
    }
  }

  return alerts;
}
