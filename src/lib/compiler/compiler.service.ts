/**
 * compileEntity() — pure function that transforms Prisma entity + fields
 * into a SuperSchemaModel IR.
 *
 * Zero side effects, zero Prisma runtime dependency.
 * Accepts plain objects matching Prisma's shape.
 */

import { activeDanglingRef } from "@/lib/field-dangling";
import type {
  SuperSchemaModel,
  SuperSchemaField,
  SuperSchemaRelationship,
  SuperSchemaEntityMetadata,
  DecoratorSet,
  ComplexTypeInfo,
  LogicalType,
  SuperSchemaAlias,
  SuperSchemaCustomScalar,
  SuperSchemaInterface,
  SuperSchemaSharedEnum,
  SuperSchemaUnionType,
} from "@/types/super-schema-model";
import { ALL_DATA_TYPES } from "@/lib/data-types";

// ---------------------------------------------------------------------------
// Input shapes — match Prisma's output without importing Prisma
// ---------------------------------------------------------------------------

export interface PrismaEntityInput {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  /** null for tenant-level entities (no domain placement). */
  domainId: string | null;
  metadata: unknown; // Prisma JSONB
  domain?: { id: string; name: string; slug: string } | null;
}

export interface PrismaFieldInput {
  id: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: unknown; // Prisma JSONB
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// compileEntity — pure function
// ---------------------------------------------------------------------------

export function compileEntity(
  entity: PrismaEntityInput,
  fields: PrismaFieldInput[]
): SuperSchemaModel {
  const metadata = parseEntityMetadata(entity.metadata);
  const domainName = entity.domain?.name || entity.domain?.slug || "unknown";

  const compiledFields = fields
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(compileField);

  const relationships = extractRelationships(metadata, fields);

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      domain: domainName,
      domainId: entity.domainId,
      description: entity.description,
      status: entity.status,
      version: entity.version,
      metadata,
    },
    fields: compiledFields,
    relationships,
    aliases: extractCustomArray<SuperSchemaAlias>(metadata.custom, "aliases"),
    customScalars: extractCustomArray<SuperSchemaCustomScalar>(metadata.custom, "customScalars"),
    interfaces: extractCustomArray<SuperSchemaInterface>(metadata.custom, "interfaces"),
    namespace: extractCustomString(metadata.custom, "namespace"),
    sharedEnums: extractCustomArray<SuperSchemaSharedEnum>(metadata.custom, "sharedEnums"),
    unionTypes: extractCustomArray<SuperSchemaUnionType>(metadata.custom, "unionTypes"),
  };
}

// ---------------------------------------------------------------------------
// Field compilation
// ---------------------------------------------------------------------------

function compileField(field: PrismaFieldInput): SuperSchemaField {
  const rawDecorators = (field.decorators ?? {}) as Record<string, unknown>;
  const decorators = extractDecoratorSet(rawDecorators);
  const complexType = extractComplexTypeInfo(field.type, rawDecorators);
  const logicalType = resolveLogicalType(field.type);

  return {
    id: field.id,
    name: field.name,
    type: logicalType,
    precision: field.precision ?? undefined,
    scale: field.scale ?? undefined,
    nullable: field.nullable,
    isKey: field.isKey,
    fieldNumber: field.fieldNumber ?? undefined,
    description: field.description,
    classification: field.classification ?? undefined,
    aliases: field.aliases ?? [],
    decorators,
    complexType: complexType ?? undefined,
    danglingRef: activeDanglingRef(logicalType, rawDecorators),
    sortOrder: field.sortOrder,
  };
}

// ---------------------------------------------------------------------------
// Type resolution
// ---------------------------------------------------------------------------

// `union` is not a pickable data type (it needs a declared union to point at), but an imported field may carry it.
const VALID_LOGICAL_TYPES = new Set<string>([...ALL_DATA_TYPES, "union"]);

function resolveLogicalType(typeId: string): LogicalType {
  if (VALID_LOGICAL_TYPES.has(typeId)) {
    return typeId as LogicalType;
  }
  // Fallback: treat unknown types as string
  return "string";
}

// ---------------------------------------------------------------------------
// Decorator extraction
// ---------------------------------------------------------------------------

function extractDecoratorSet(raw: Record<string, unknown>): DecoratorSet {
  const result: DecoratorSet = {};

  if (raw.structure && typeof raw.structure === "object") {
    result.structure = raw.structure as DecoratorSet["structure"];
  }
  if (raw.semantics && typeof raw.semantics === "object") {
    result.semantics = raw.semantics as DecoratorSet["semantics"];
  }
  if (raw.classification && typeof raw.classification === "object") {
    result.classification = raw.classification as DecoratorSet["classification"];
  }
  if (raw.policy && typeof raw.policy === "object") {
    result.policy = raw.policy as DecoratorSet["policy"];
  }
  if (raw.quality && typeof raw.quality === "object") {
    result.quality = raw.quality as DecoratorSet["quality"];
  }
  if (raw.lineage && typeof raw.lineage === "object") {
    result.lineage = raw.lineage as DecoratorSet["lineage"];
  }
  if (raw.operationalHints && typeof raw.operationalHints === "object") {
    result.operationalHints = raw.operationalHints as DecoratorSet["operationalHints"];
  }
  if (raw.evolution && typeof raw.evolution === "object") {
    result.evolution = raw.evolution as DecoratorSet["evolution"];
  }
  if (raw.typespec && typeof raw.typespec === "object") {
    result.typespec = raw.typespec as DecoratorSet["typespec"];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Complex type info extraction
// ---------------------------------------------------------------------------

/** `unionName` / `unionMembers` of a union-typed field (or an array of unions), type-checked: they come from stored JSON. */
function unionInfo(decorators: Record<string, unknown>): Pick<ComplexTypeInfo, "unionName" | "unionMembers"> {
  const members = stringArray(decorators.unionMembers);
  return {
    unionName: typeof decorators.unionName === "string" ? decorators.unionName : undefined,
    unionMembers: members && members.length > 0 ? members : undefined,
  };
}

function extractComplexTypeInfo(
  type: string,
  decorators: Record<string, unknown>
): ComplexTypeInfo | null {
  switch (type) {
    case "array":
      return {
        arrayElementType: (decorators.arrayElementType as string) ?? undefined,
        arrayElementPrecision: (decorators.arrayElementPrecision as number) ?? undefined,
        arrayElementScale: (decorators.arrayElementScale as number) ?? undefined,
        // Target entity when the array holds references (items: { $ref }).
        referencedEntityName: (decorators.referencedEntityName as string) ?? undefined,
        enumValues: stringArray(decorators.enumValues),
        ...unionInfo(decorators),
      };
    case "map":
      return {
        mapKeyType: (decorators.mapKeyType as string) ?? undefined,
        mapValueType: (decorators.mapValueType as string) ?? undefined,
        // Target entity when the map values are references.
        referencedEntityName: (decorators.referencedEntityName as string) ?? undefined,
        enumValues: stringArray(decorators.enumValues),
      };
    case "object":
      return {
        nestedFields: Array.isArray(decorators.nestedFields)
          ? (decorators.nestedFields as ComplexTypeInfo["nestedFields"])
          : undefined,
      };
    case "reference":
      return {
        referencedEntityId: (decorators.referencedEntityId as string) ?? undefined,
        referencedEntityName: (decorators.referencedEntityName as string) ?? undefined,
        referencedQualifiedName: (decorators.referencedQualifiedName as string) ?? undefined,
        referencedEntityVersion: (decorators.referencedEntityVersion as string) ?? undefined,
      };
    case "union":
      return unionInfo(decorators);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Entity metadata parsing
// ---------------------------------------------------------------------------

function parseEntityMetadata(raw: unknown): SuperSchemaEntityMetadata {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const meta = raw as Record<string, unknown>;
  const result: SuperSchemaEntityMetadata = {};

  if (Array.isArray(meta.tags)) {
    result.tags = meta.tags as string[];
  }
  if (Array.isArray(meta.relationships)) {
    result.relationships = meta.relationships as SuperSchemaRelationship[];
  }
  if (meta.deprecation && typeof meta.deprecation === "object") {
    result.deprecation = meta.deprecation as SuperSchemaEntityMetadata["deprecation"];
  }
  if (meta.custom && typeof meta.custom === "object") {
    result.custom = meta.custom as Record<string, unknown>;
  }
  if (meta.retentionPolicy && typeof meta.retentionPolicy === "object") {
    result.retentionPolicy =
      meta.retentionPolicy as SuperSchemaEntityMetadata["retentionPolicy"];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Relationship extraction — from entity metadata + reference fields
// ---------------------------------------------------------------------------

function extractRelationships(
  metadata: SuperSchemaEntityMetadata,
  fields: PrismaFieldInput[]
): SuperSchemaRelationship[] {
  const relationships: SuperSchemaRelationship[] = [];

  // From entity metadata
  if (metadata.relationships) {
    relationships.push(...metadata.relationships);
  }

  // From reference-type fields not already in metadata
  const existingTargets = new Set(
    relationships.map((r) => `${r.targetEntityId}:${r.fieldId}`)
  );

  for (const field of fields) {
    if (field.type === "reference") {
      const decorators = (field.decorators ?? {}) as Record<string, unknown>;
      const targetId = decorators.referencedEntityId as string | undefined;
      if (targetId && !existingTargets.has(`${targetId}:${field.id}`)) {
        relationships.push({
          targetEntityId: targetId,
          fieldId: field.id,
          cardinality: "many-to-one",
        });
      }
    }
  }

  return relationships;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

function extractCustomArray<T>(
  custom: Record<string, unknown> | undefined,
  key: string
): T[] | undefined {
  const value = custom?.[key];
  return Array.isArray(value) ? (value as T[]) : undefined;
}

function extractCustomString(
  custom: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = custom?.[key];
  return typeof value === "string" ? value : undefined;
}
