import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import { resolveMappingWithPrecision } from "@/lib/type-mapping/mapping-engine";
import type { MappingResult, ScopedMappingPolicy } from "@/lib/type-mapping/types";

export interface FieldTargetTypeOverride {
  fieldId: string;
  fieldName: string;
  sourceType: string;
  target: string;
  defaultMappedType: string | null;
  mappedType: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  comment: string;
}

export type SchemaTargetTypeOverrides = Record<
  string,
  Record<string, FieldTargetTypeOverride>
>;

export interface SchemaTargetFieldMappingRow {
  fieldId: string;
  fieldName: string;
  sourceType: string;
  precision?: number;
  scale?: number;
  defaultMappedType: string | null;
  effectiveMappedType: string;
  overrideSource?: "field" | "global" | "per-entity";
  isOverride: boolean;
  isStale: boolean;
  comment?: string;
}

export function parseSchemaTargetTypeOverrides(raw: unknown): SchemaTargetTypeOverrides {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const result: SchemaTargetTypeOverrides = {};

  for (const [target, maybeOverrides] of Object.entries(raw as Record<string, unknown>)) {
    if (!maybeOverrides || typeof maybeOverrides !== "object") {
      continue;
    }

    const targetOverrides: Record<string, FieldTargetTypeOverride> = {};

    for (const [fieldId, maybeOverride] of Object.entries(
      maybeOverrides as Record<string, unknown>
    )) {
      if (!maybeOverride || typeof maybeOverride !== "object") {
        continue;
      }

      const override = maybeOverride as Record<string, unknown>;
      if (
        typeof override.fieldId !== "string" ||
        typeof override.fieldName !== "string" ||
        typeof override.sourceType !== "string" ||
        typeof override.mappedType !== "string"
      ) {
        continue;
      }

      targetOverrides[fieldId] = {
        fieldId: override.fieldId,
        fieldName: override.fieldName,
        sourceType: override.sourceType,
        target: typeof override.target === "string" ? override.target : target,
        defaultMappedType:
          typeof override.defaultMappedType === "string"
            ? override.defaultMappedType
            : null,
        mappedType: override.mappedType,
        createdAt:
          typeof override.createdAt === "string"
            ? override.createdAt
            : new Date().toISOString(),
        updatedAt:
          typeof override.updatedAt === "string"
            ? override.updatedAt
            : new Date().toISOString(),
        updatedBy:
          typeof override.updatedBy === "string" ? override.updatedBy : undefined,
        comment:
          typeof override.comment === "string"
            ? override.comment
            : buildFieldOverrideComment({
                sourceType: override.sourceType,
                defaultMappedType:
                  typeof override.defaultMappedType === "string"
                    ? override.defaultMappedType
                    : null,
                mappedType: override.mappedType,
              }),
      };
    }

    if (Object.keys(targetOverrides).length > 0) {
      result[target] = targetOverrides;
    }
  }

  return result;
}

export function buildFieldOverrideComment(input: {
  sourceType: string;
  defaultMappedType: string | null;
  mappedType: string;
}): string {
  const defaultPart = input.defaultMappedType
    ? `defaulted to ${input.defaultMappedType}`
    : "had no default mapping";
  return `SUPER SCHEMA TYPE OVERRIDE: logical ${input.sourceType} ${defaultPart}; user selected ${input.mappedType}.`;
}

export function getFieldOverrideCommentFromMapping(
  sourceType: string,
  mapping: MappingResult
): string | null {
  if (!mapping.isOverride || mapping.overrideSource !== "field") {
    return null;
  }

  return buildFieldOverrideComment({
    sourceType,
    defaultMappedType: mapping.defaultMappedType ?? null,
    mappedType: mapping.mappedType,
  });
}

export function toFieldOverridePolicies(
  overrides: SchemaTargetTypeOverrides,
  target: string
): ScopedMappingPolicy[] {
  const targetOverrides = overrides[target] ?? {};

  return Object.values(targetOverrides).map((override) => ({
    sourceType: override.sourceType,
    targetType: override.mappedType,
    targetFormat: target,
    mappedType: override.mappedType,
    isOverride: true,
    isLossy: false,
    fieldId: override.fieldId,
    fieldName: override.fieldName,
  }));
}

export function buildSchemaTargetFieldMappings(
  fields: PrismaFieldInput[],
  target: string,
  policies: ScopedMappingPolicy[],
  overrides: SchemaTargetTypeOverrides,
  entityId: string
): SchemaTargetFieldMappingRow[] {
  const defaultPolicies = getDefaultPolicies();
  const targetOverrides = overrides[target] ?? {};

  return fields.map((field) => {
    const defaultResult = resolveMappingWithPrecision(
      field.type,
      target,
      defaultPolicies,
      field.precision ?? undefined,
      field.scale ?? undefined
    );
    const effectiveResult = resolveMappingWithPrecision(
      field.type,
      target,
      policies,
      field.precision ?? undefined,
      field.scale ?? undefined,
      entityId,
      field.id
    );

    const parsedOverride = targetOverrides[field.id];
    const defaultMappedType = defaultResult.success
      ? defaultResult.result.mappedType
      : null;
    const effectiveMappedType = effectiveResult.success
      ? effectiveResult.result.mappedType
      : parsedOverride?.mappedType ?? defaultMappedType ?? "UNMAPPED";

    const isStale = Boolean(
      parsedOverride &&
        (parsedOverride.sourceType !== field.type ||
          parsedOverride.defaultMappedType !== defaultMappedType)
    );

    return {
      fieldId: field.id,
      fieldName: field.name,
      sourceType: field.type,
      precision: field.precision ?? undefined,
      scale: field.scale ?? undefined,
      defaultMappedType,
      effectiveMappedType,
      overrideSource: effectiveResult.success
        ? effectiveResult.result.overrideSource
        : undefined,
      isOverride: effectiveResult.success
        ? effectiveResult.result.isOverride
        : Boolean(parsedOverride),
      isStale,
      comment: parsedOverride?.comment,
    };
  });
}

export function upsertFieldTargetTypeOverride(
  existing: SchemaTargetTypeOverrides,
  params: {
    target: string;
    fieldId: string;
    fieldName: string;
    sourceType: string;
    mappedType: string;
    defaultMappedType: string | null;
    userId?: string;
    now?: string;
  }
): SchemaTargetTypeOverrides {
  const now = params.now ?? new Date().toISOString();
  const next = { ...existing };
  const targetOverrides = { ...(next[params.target] ?? {}) };

  targetOverrides[params.fieldId] = {
    fieldId: params.fieldId,
    fieldName: params.fieldName,
    sourceType: params.sourceType,
    target: params.target,
    defaultMappedType: params.defaultMappedType,
    mappedType: params.mappedType,
    createdAt: targetOverrides[params.fieldId]?.createdAt ?? now,
    updatedAt: now,
    updatedBy: params.userId,
    comment: buildFieldOverrideComment({
      sourceType: params.sourceType,
      defaultMappedType: params.defaultMappedType,
      mappedType: params.mappedType,
    }),
  };

  next[params.target] = targetOverrides;
  return next;
}

export function removeFieldTargetTypeOverride(
  existing: SchemaTargetTypeOverrides,
  target: string,
  fieldId: string
): SchemaTargetTypeOverrides {
  const next = { ...existing };
  const targetOverrides = { ...(next[target] ?? {}) };
  delete targetOverrides[fieldId];

  if (Object.keys(targetOverrides).length === 0) {
    delete next[target];
  } else {
    next[target] = targetOverrides;
  }

  return next;
}
