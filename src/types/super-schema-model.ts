/**
 * SuperSchemaModel — the Intermediate Representation (IR) that decouples
 * emitters from TypeSpec internals. Emitters receive this model, never the
 * TypeSpec `Program` object.
 *
 * This is a pure data structure with zero Prisma or framework dependencies.
 */

// ---------------------------------------------------------------------------
// Logical type — covers every supported field type
// ---------------------------------------------------------------------------

export type LogicalType =
  | "string"
  | "url"
  | "integer"
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "safeint"
  | "uint8"
  | "uint16"
  | "uint32"
  | "uint64"
  | "numeric"
  | "float"
  | "float32"
  | "float64"
  | "decimal"
  | "decimal128"
  | "boolean"
  | "bytes"
  | "plainDate"
  | "plainTime"
  | "utcDateTime"
  | "offsetDateTime"
  | "duration"
  | "unixTimestamp32"
  | "enum"
  | "array"
  | "map"
  | "object"
  | "reference"
  | "union";

// ---------------------------------------------------------------------------
// Decorator categories (8 categories + 7 typespec panels)
// ---------------------------------------------------------------------------

export interface StructureDecorators {
  nullable?: boolean;
  key?: boolean;
}

export interface SemanticsDecorators {
  description?: string;
  aliases?: string[];
  glossaryTerms?: string[];
}

export interface ClassificationDecorators {
  level?: "PII" | "SENSITIVE" | "INTERNAL" | "PUBLIC";
  customLevel?: string | null;
}

export interface PolicyDecorators {
  retention?: string;
  anonymization?: string;
  encryption?: string;
}

export interface QualityRule {
  type: string;
  params: Record<string, unknown>;
}

export interface QualityDecorators {
  rules?: QualityRule[];
}

export interface LineageDecorators {
  source?: string;
  upstream?: string[];
  downstream?: string[];
}

export interface OperationalHintsDecorators {
  partition?: boolean;
  index?: boolean;
  cluster?: boolean;
}

export interface EvolutionDecorators {
  deprecated?: boolean;
  since?: string;
  replacement?: string | null;
}

// TypeSpec 7-panel decorators
export interface IdentityDecorators {
  key?: boolean;
  discriminator?: boolean;
  secret?: boolean;
  format?: string | null;
  optional?: boolean;
  defaultValue?: unknown;
}

export interface ValidationDecorators {
  minValue?: number | null;
  maxValue?: number | null;
  minValueExclusive?: number | null;
  maxValueExclusive?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  pattern?: string | null;
  minItems?: number | null;
  maxItems?: number | null;
}

export interface WireFormatDecorators {
  encode?: string | null;
  encodeSubType?: string | null;
  encodedNames?: Record<string, string>;
  httpBinding?:
    | "none"
    | "header"
    | "query"
    | "path"
    | "cookie"
    | "body"
    | "bodyRoot"
    | "bodyIgnore"
    | "statusCode"
    | null;
  httpBindingName?: string | null;
}

export interface VisibilityDecorators {
  phases?: ("Create" | "Read" | "Update" | "Delete" | "Query")[];
  invisible?: boolean;
  removeVisibility?: boolean;
}

export interface DocumentationDecorators {
  doc?: string;
  summary?: string;
  example?: unknown;
  deprecated?: string | null;
  externalDocsUrl?: string | null;
  externalDocsDescription?: string | null;
}

export interface VersioningDecorators {
  added?: string | null;
  removed?: string | null;
  renamedFrom?: { version: string; oldName: string } | null;
  madeOptional?: string | null;
  madeRequired?: string | null;
  typeChangedFrom?: { version: string; oldType: string } | null;
}

export interface ExtensionsDecorators {
  openapi?: Record<string, unknown>;
  xml?: {
    attribute?: boolean;
    element?: boolean;
    namespace?: string | null;
    namespacePrefix?: string | null;
    name?: string | null;
  };
}

// Combined typespec panel decorators
export interface TypeSpecPanelDecorators {
  identity?: IdentityDecorators;
  validation?: ValidationDecorators;
  wireFormat?: WireFormatDecorators;
  visibility?: VisibilityDecorators;
  documentation?: DocumentationDecorators;
  versioning?: VersioningDecorators;
  extensions?: ExtensionsDecorators;
}

// Full decorator set: 8 categories + typespec panels
export interface DecoratorSet {
  structure?: StructureDecorators;
  semantics?: SemanticsDecorators;
  classification?: ClassificationDecorators;
  policy?: PolicyDecorators;
  quality?: QualityDecorators;
  lineage?: LineageDecorators;
  operationalHints?: OperationalHintsDecorators;
  evolution?: EvolutionDecorators;
  typespec?: TypeSpecPanelDecorators;
}

// ---------------------------------------------------------------------------
// Complex type metadata
// ---------------------------------------------------------------------------

export interface ComplexTypeInfo {
  // Array
  arrayElementType?: string;
  arrayElementPrecision?: number;
  arrayElementScale?: number;
  // Map
  mapKeyType?: string;
  mapValueType?: string;
  // Enum symbols of an array element / map value of type "enum"
  enumValues?: string[];
  // Object/nested
  nestedFields?: NestedFieldInfo[];
  // Reference
  referencedEntityId?: string;
  referencedEntityName?: string;
  // Union (a field typed by a named union, or an array of one)
  unionName?: string;
}

export interface NestedFieldInfo {
  name: string;
  type: string;
  description?: string;
  nullable?: boolean;
  decorators?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Field in the IR
// ---------------------------------------------------------------------------

export interface SuperSchemaField {
  id?: string;
  name: string;
  type: LogicalType;
  precision?: number;
  scale?: number;
  nullable: boolean;
  isKey: boolean;
  fieldNumber?: number;
  description: string;
  classification?: string;
  aliases: string[];
  decorators: DecoratorSet;
  complexType?: ComplexTypeInfo;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Relationship in the IR
// ---------------------------------------------------------------------------

export interface SuperSchemaRelationship {
  targetEntityId: string;
  fieldId: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  foreignKey?: string;
}

// ---------------------------------------------------------------------------
// Entity metadata in the IR
// ---------------------------------------------------------------------------

export interface SuperSchemaRetentionPolicy {
  strategy: "age-based" | "condition-based" | "rolling-window" | "indefinite";
  period?: number;
  periodUnit?: "days" | "months" | "years";
  referenceField?: string;
  condition?: string;
  action: "delete" | "archive" | "anonymize" | "notify-only";
  description?: string;
}

export interface SuperSchemaEntityMetadata {
  tags?: string[];
  relationships?: SuperSchemaRelationship[];
  deprecation?: {
    deprecated: boolean;
    since?: string;
    replacement?: string | null;
    replacementEntityId?: string | null;
    reason?: string;
    migrationNotes?: string;
  };
  custom?: Record<string, unknown>;
  retentionPolicy?: SuperSchemaRetentionPolicy;
  isError?: boolean;
  friendlyName?: string;
}

// ---------------------------------------------------------------------------
// Shared Enum in the IR
// ---------------------------------------------------------------------------

export interface SuperSchemaSharedEnum {
  name: string;
  values: string[];
  description?: string;
}

// ---------------------------------------------------------------------------
// Custom Scalar in the IR
// ---------------------------------------------------------------------------

export interface SuperSchemaCustomScalar {
  name: string;
  baseType: string;
  format?: string;
  pattern?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Union Type in the IR
// ---------------------------------------------------------------------------

export interface SuperSchemaUnionType {
  name: string;
  memberTypes: string[];
  description?: string;
}

// ---------------------------------------------------------------------------
// Alias in the IR
// ---------------------------------------------------------------------------

export interface SuperSchemaAlias {
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Operation in the IR
// ---------------------------------------------------------------------------

export interface SuperSchemaOperationParameter {
  name: string;
  type: string;
  location: "path" | "query" | "header" | "body";
  required: boolean;
  description?: string;
}

export interface SuperSchemaOperationResponse {
  statusCode: number;
  type?: string;
  description?: string;
}

export interface SuperSchemaOperation {
  name: string;
  httpMethod: string;
  httpPath: string;
  description?: string;
  parameters: SuperSchemaOperationParameter[];
  responses: SuperSchemaOperationResponse[];
}

// ---------------------------------------------------------------------------
// Interface Definition in the IR
// ---------------------------------------------------------------------------

export interface SuperSchemaInterface {
  name: string;
  description?: string;
  operations: SuperSchemaOperation[];
}

// ---------------------------------------------------------------------------
// The SuperSchemaModel — top-level IR
// ---------------------------------------------------------------------------

export interface SuperSchemaModel {
  entity: {
    id: string;
    name: string;
    domain: string;
    /** null for tenant-level entities (no domain placement). */
    domainId: string | null;
    description: string;
    status: string;
    version: number;
    metadata: SuperSchemaEntityMetadata;
    parentEntityName?: string;
    spreadFrom?: string[];
  };
  fields: SuperSchemaField[];
  relationships: SuperSchemaRelationship[];
  sharedEnums?: SuperSchemaSharedEnum[];
  customScalars?: SuperSchemaCustomScalar[];
  unionTypes?: SuperSchemaUnionType[];
  aliases?: SuperSchemaAlias[];
  interfaces?: SuperSchemaInterface[];
  namespace?: string;
}

// ---------------------------------------------------------------------------
// Mapping policy type
// ---------------------------------------------------------------------------

export type MappingPolicy = {
  sourceType: string;
  targetType: string;
  targetFormat: string;
  mappedType: string;
  isOverride: boolean;
  approvedBy?: string;
};
