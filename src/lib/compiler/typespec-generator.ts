/**
 * TypeSpec source code generator.
 *
 * Transforms a SuperSchemaModel IR into a valid TypeSpec (.tsp) source string.
 * Supports: models (with inheritance/spread), enums, custom scalars, unions,
 * aliases, namespaces, operations, interfaces.
 *
 * Pure function — no side effects, no I/O.
 */

import type {
  SuperSchemaModel,
  SuperSchemaField,
  LogicalType,
  SuperSchemaSharedEnum,
  SuperSchemaCustomScalar,
  SuperSchemaUnionType,
  SuperSchemaInterface,
  SuperSchemaOperation,
} from "@/types/super-schema-model";
import { getTypeInfo } from "@/lib/data-types";
import { boundFor, constraintAppliesTo, type BoundKind, type ConstraintKind } from "@/lib/compiler/constraint-targets";
import { activeDanglingRef } from "@/lib/field-dangling";
import {
  ENTERPRISE_NAMESPACE,
  ENTITY_STORED_ONLY_EXTENSION_KEYS,
  LIBRARY_IMPORTS,
  classificationDecorator,
  tagsDecorator,
  type GovernanceLibrary,
  JSON_SCHEMA_LIBRARY_IMPORT,
  genericExtensionDecorators,
  genericExtensionEntries,
  escapeTypeSpecString,
  pinDecorator,
  PIN_EXTENSION_KEY,
} from "./governance-decorators";
import {
  enumMemberName,
  escapeString,
  propertyName,
  quoteIdentifier,
  sanitizeIdentifier,
  sanitizeIdentifierSegment,
} from "./typespec-identifiers";

// The identifier rules live in typespec-identifiers.ts (shared with the protobuf / Avro projections and the emitter
// service); re-exported here so the generator stays the one import for generated-source spelling.
export {
  TYPESPEC_HARD_KEYWORDS,
  TYPESPEC_KEYWORDS,
  TYPESPEC_RESERVED_FUTURE_WORDS,
  enumMemberName,
  escapeString,
  isPlainIdentifier,
  propertyName,
  quoteIdentifier,
  sanitizeIdentifier,
  sanitizeIdentifierSegment,
} from "./typespec-identifiers";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateTypeSpecOptions {
  /**
   * Emit the governance overlay (Story 16.6): field classification
   * (`@Enterprise.dataClassification(...)` / `x-classification`), entity tags (`x-tags`) and the library
   * imports they need. Default true — the canonical source carries it. Emission projections pass false
   * (see `emitter.service.ts#buildSourceForTarget`).
   */
  governance?: boolean;
  /**
   * Generate this entity as one member of a combined closure document (see `closure-source.ts`): the model gets the
   * closure-unique `modelName` (so do its field-scoped enums, `<modelName>_<field>`), no `namespace X;` line is written (the
   * caller wraps the output in a `namespace X { ... }` block), and a reference field is typed by `referenceType`.
   * Absent: the stand-alone path, untouched.
   */
  closureMember?: ClosureMemberOptions;
}

export interface ClosureMemberOptions {
  /** The model's name in the closure (already a valid, closure-unique identifier). */
  modelName: string;
  /**
   * The TypeSpec type of a reference field (or of an array / map member): `string` is the qualified model, `null` a
   * reference whose target is not in the closure (generated as `unknown`, never as a name nothing declares).
   */
  referenceType(field: SuperSchemaField): string | null;
  /** The document uses the name `Enterprise` itself (a namespace segment or model), so classifications ride as extensions. */
  enterpriseShadowed?: boolean;
  /** The fully qualified model this one extends (`SuperSchemaClosure.D.P.Base.Base`); absent: it extends nothing. */
  baseType?: string;
}

/**
 * Something the generator could not express faithfully. An `error` also surfaces as a compile error in the
 * generated source (a publish / emission fails loudly instead of shipping an unsatisfiable schema); a `warning`
 * was repaired (a duplicate enum symbol is dropped) and is only reported.
 */
export interface GeneratorDiagnostic {
  severity: "error" | "warning";
  code: "ENUM_NO_VALUES" | "ENUM_DUPLICATE_VALUE";
  fieldName?: string;
  message: string;
}

export interface GeneratedTypeSpec {
  source: string;
  diagnostics: GeneratorDiagnostic[];
}

/**
 * Generate TypeSpec source from a SuperSchemaModel.
 * Returns a valid TypeSpec .tsp string that compiles standalone.
 */
export function generateTypeSpec(model: SuperSchemaModel, options: GenerateTypeSpecOptions = {}): string {
  return generateTypeSpecWithDiagnostics(model, options).source;
}

/** {@link generateTypeSpec} plus a report of everything that could not be expressed faithfully. */
export function generateTypeSpecWithDiagnostics(
  standalone: SuperSchemaModel,
  options: GenerateTypeSpecOptions = {}
): GeneratedTypeSpec {
  const member = options.closureMember;
  const model: SuperSchemaModel = member
    ? { ...standalone, entity: { ...standalone.entity, name: member.modelName, parentEntityName: member.baseType }, namespace: undefined }
    : standalone;
  const governance = resolveGovernance(model, options);
  const ctx = createContext(model, member?.referenceType);
  const lines: string[] = [...governanceImportLines(model, governance)];

  // Emit namespace if present
  const ns = model.namespace || model.entity.domain;
  const useNamespace = model.namespace !== undefined;

  if (useNamespace && ns) {
    lines.push(`namespace ${sanitizeNamespace(ns)};`);
    lines.push("");
  }

  // Emit custom scalars
  if (model.customScalars && model.customScalars.length > 0) {
    for (const scalar of model.customScalars) {
      lines.push(...generateScalarDefinition(scalar));
      lines.push("");
    }
  }

  // Emit shared enums
  if (model.sharedEnums && model.sharedEnums.length > 0) {
    for (const sharedEnum of model.sharedEnums) {
      lines.push(...generateSharedEnumDefinition(sharedEnum, ctx));
      lines.push("");
    }
  }

  // Emit unions
  if (model.unionTypes && model.unionTypes.length > 0) {
    for (const union of model.unionTypes) {
      lines.push(...generateUnionDefinition(union));
      lines.push("");
    }
  }

  // Emit aliases
  if (model.aliases && model.aliases.length > 0) {
    for (const alias of model.aliases) {
      lines.push(`alias ${sanitizeIdentifier(alias.name)} = ${alias.type};`);
      lines.push("");
    }
  }

  // Emit inline enum definitions (for enum-type fields not in shared enums)
  for (const field of model.fields.filter(needsInlineEnum)) {
    // Only emit inline enum if it's not a shared enum reference
    if (ctx.declaresInlineEnum(field)) {
      lines.push(...generateInlineEnumDefinition(field, ctx));
      lines.push("");
    }
  }

  // Emit model-level decorators
  lines.push(...generateModelDecorators(model, governance));

  // Emit model definition with optional extends
  const modelName = sanitizeIdentifier(model.entity.name);
  const extendsClause = model.entity.parentEntityName
    ? ` extends ${model.entity.parentEntityName.split(".").map(sanitizeIdentifier).join(".")}`
    : "";
  lines.push(`model ${modelName}${extendsClause} {`);

  // Emit spread references
  if (model.entity.spreadFrom && model.entity.spreadFrom.length > 0) {
    for (const spreadName of model.entity.spreadFrom) {
      lines.push(`  ...${sanitizeIdentifier(spreadName)};`);
    }
  }

  // Emit fields
  for (const field of model.fields) {
    const fieldLines = generateFieldDefinition(field, ctx, governance);
    for (const fl of fieldLines) {
      lines.push(`  ${fl}`);
    }
  }

  lines.push("}");

  // Emit interfaces
  if (model.interfaces && model.interfaces.length > 0) {
    for (const iface of model.interfaces) {
      lines.push("");
      lines.push(...generateInterfaceDefinition(iface));
    }
  }

  return { source: lines.join("\n") + "\n", diagnostics: ctx.diagnostics };
}

/**
 * Generate TypeSpec source directly from Prisma-shaped entity + fields.
 * Convenience wrapper that calls compileEntity() then generateTypeSpec().
 */
export { generateTypeSpec as generateTypeSpecFromModel };

// ---------------------------------------------------------------------------
// Source map for error mapping
// ---------------------------------------------------------------------------

export interface SourceMapEntry {
  fieldName: string;
  startLine: number;
  endLine: number;
}

/**
 * Generate TypeSpec source along with a source map.
 * Used for mapping compilation errors back to field names.
 */
export function generateTypeSpecWithSourceMap(
  model: SuperSchemaModel,
  options: GenerateTypeSpecOptions = {}
): { source: string; sourceMap: SourceMapEntry[] } {
  const governance = resolveGovernance(model, options);
  const ctx = createContext(model);
  const lines: string[] = [...governanceImportLines(model, governance)];
  const sourceMap: SourceMapEntry[] = [];

  // Namespace
  const ns = model.namespace || model.entity.domain;
  const useNamespace = model.namespace !== undefined;
  if (useNamespace && ns) {
    lines.push(`namespace ${sanitizeNamespace(ns)};`);
    lines.push("");
  }

  // Custom scalars
  if (model.customScalars && model.customScalars.length > 0) {
    for (const scalar of model.customScalars) {
      lines.push(...generateScalarDefinition(scalar));
      lines.push("");
    }
  }

  // Shared enums
  if (model.sharedEnums && model.sharedEnums.length > 0) {
    for (const sharedEnum of model.sharedEnums) {
      lines.push(...generateSharedEnumDefinition(sharedEnum, ctx));
      lines.push("");
    }
  }

  // Unions
  if (model.unionTypes && model.unionTypes.length > 0) {
    for (const union of model.unionTypes) {
      lines.push(...generateUnionDefinition(union));
      lines.push("");
    }
  }

  // Aliases
  if (model.aliases && model.aliases.length > 0) {
    for (const alias of model.aliases) {
      lines.push(`alias ${sanitizeIdentifier(alias.name)} = ${alias.type};`);
      lines.push("");
    }
  }

  // Emit inline enum definitions first
  for (const field of model.fields.filter(needsInlineEnum)) {
    if (ctx.declaresInlineEnum(field)) {
      const startLine = lines.length + 1;
      lines.push(...generateInlineEnumDefinition(field, ctx));
      lines.push("");
      sourceMap.push({
        fieldName: field.name,
        startLine,
        endLine: lines.length,
      });
    }
  }

  // Emit model-level decorators
  lines.push(...generateModelDecorators(model, governance));

  // Emit model definition
  const modelName = sanitizeIdentifier(model.entity.name);
  const extendsClause = model.entity.parentEntityName
    ? ` extends ${model.entity.parentEntityName.split(".").map(sanitizeIdentifier).join(".")}`
    : "";
  lines.push(`model ${modelName}${extendsClause} {`);

  // Spread
  if (model.entity.spreadFrom && model.entity.spreadFrom.length > 0) {
    for (const spreadName of model.entity.spreadFrom) {
      lines.push(`  ...${sanitizeIdentifier(spreadName)};`);
    }
  }

  // Emit fields with source map tracking
  for (const field of model.fields) {
    const startLine = lines.length + 1;
    const fieldLines = generateFieldDefinition(field, ctx, governance);
    for (const fl of fieldLines) {
      lines.push(`  ${fl}`);
    }
    sourceMap.push({
      fieldName: field.name,
      startLine,
      endLine: lines.length,
    });
  }

  lines.push("}");

  return {
    source: lines.join("\n") + "\n",
    sourceMap,
  };
}

// ---------------------------------------------------------------------------
// Model-level decorators
// ---------------------------------------------------------------------------

/** What the governance overlay does for one generated document. */
interface Governance {
  enabled: boolean;
  /**
   * A top-level name in the document is `Enterprise`, so `@Enterprise.dataClassification` would not resolve
   * to the governance library (see {@link ENTERPRISE_NAMESPACE}): every classification is then emitted as
   * the lossless `x-classification` extension and the enterprise library is not imported.
   */
  enterpriseShadowed: boolean;
}

function resolveGovernance(model: SuperSchemaModel, options: GenerateTypeSpecOptions): Governance {
  const enabled = options.governance !== false;
  const shadowed = options.closureMember?.enterpriseShadowed === true || declaresOrReferencesEnterprise(model);
  return { enabled, enterpriseShadowed: enabled && shadowed };
}

/**
 * True when the document declares, references or namespaces a top-level name `Enterprise`: the entity
 * itself, its parent / spread / reference targets (which the publish gate stubs as `model X {}`), shared
 * enums, scalars, unions, aliases, interfaces, or a segment of the namespace. Each one either collides with
 * `namespace Enterprise` of the governance library (duplicate-symbol, global scope) or captures the name
 * `Enterprise` before the library does (inside a namespace).
 */
function declaresOrReferencesEnterprise(model: SuperSchemaModel): boolean {
  const names: string[] = [model.entity.name, ...(model.entity.spreadFrom ?? [])];
  if (model.entity.parentEntityName) names.push(model.entity.parentEntityName);
  for (const field of model.fields) {
    if (field.complexType?.referencedEntityName) names.push(field.complexType.referencedEntityName);
  }
  for (const group of [model.sharedEnums, model.customScalars, model.unionTypes, model.aliases, model.interfaces]) {
    for (const declared of group ?? []) names.push(declared.name);
  }
  const ns = model.namespace || model.entity.domain;
  if (model.namespace !== undefined && ns) names.push(...ns.split("."));
  return names.some((name) => sanitizeIdentifier(name) === ENTERPRISE_NAMESPACE);
}

/**
 * `import` lines for the libraries the governance overlay uses (none when it is off or empty), followed by
 * a blank line. Imports must precede every other statement, so they open the file.
 */
function governanceImportLines(model: SuperSchemaModel, governance: Governance): string[] {
  const used = new Set<GovernanceLibrary>();
  if (governance.enabled) {
    if (model.entity.metadata?.tags && model.entity.metadata.tags.length > 0) used.add("openapi");
    for (const field of model.fields) {
      if (field.classification) used.add(classificationDecorator(field.classification, governance.enterpriseShadowed).library);
      if (fieldPin(field) !== undefined) used.add("openapi");
    }
  }
  // Generic extension passthrough is not a governance feature: it needs both libraries whatever the flag.
  const hasGeneric = hasGenericExtensions(model);
  if (hasGeneric) used.add("openapi");
  const ordered = (["enterprise", "openapi"] as const).filter((lib) => used.has(lib));
  const lines = ordered.map((lib) => LIBRARY_IMPORTS[lib]);
  if (hasGeneric) lines.push(JSON_SCHEMA_LIBRARY_IMPORT);
  return lines.length > 0 ? [...lines, ""] : [];
}

/** Model-level generic extensions: a flat record under `metadata.custom.extensions`. */
function modelExtensions(model: SuperSchemaModel): Record<string, unknown> | undefined {
  const ext = model.entity.metadata?.custom?.extensions;
  return ext && typeof ext === "object" && !Array.isArray(ext) ? (ext as Record<string, unknown>) : undefined;
}

function hasGenericExtensions(model: SuperSchemaModel): boolean {
  return (
    genericExtensionEntries(modelExtensions(model)).some(([key]) => !ENTITY_STORED_ONLY_EXTENSION_KEYS.includes(key)) ||
    model.fields.some((f) => genericExtensionEntries(f.decorators.typespec?.extensions?.openapi).length > 0) ||
    model.fields.some((f) => isDanglingField(f))
  );
}

function generateModelDecorators(model: SuperSchemaModel, governance: Governance): string[] {
  const lines: string[] = [];

  if (model.entity.description) {
    lines.push(`@doc("${escapeString(model.entity.description)}")`);
  }

  if (model.entity.metadata?.isError) {
    lines.push("@error");
  }

  if (model.entity.metadata?.friendlyName) {
    lines.push(`@friendlyName("${escapeString(model.entity.metadata.friendlyName)}")`);
  }

  // Entity tags (Story 16.6): one valid `x-tags` extension — `@tag` is not allowed on a model.
  if (governance.enabled && model.entity.metadata?.tags && model.entity.metadata.tags.length > 0) {
    lines.push(tagsDecorator(model.entity.metadata.tags));
  }

  // Generic vendor extensions (flat record in metadata.custom.extensions).
  lines.push(...genericExtensionDecorators(modelExtensions(model), ENTITY_STORED_ONLY_EXTENSION_KEYS));

  return lines;
}

// ---------------------------------------------------------------------------
// Generation context: enum naming + diagnostics
// ---------------------------------------------------------------------------

interface GenContext {
  /** The entity (model) name the inline enums are scoped to. */
  entityName: string;
  diagnostics: GeneratorDiagnostic[];
  /** TypeSpec type name of the field-scoped enum of `field` (unique within the document). */
  enumNameOf(field: SuperSchemaField): string;
  /** False when the field reuses a shared enum of the same name, so no field-scoped enum is declared. */
  declaresInlineEnum(field: SuperSchemaField): boolean;
  /** True for a field-scoped enum with no symbols (never declared; the field fails loudly instead). */
  hasNoEnumValues(field: SuperSchemaField): boolean;
  /** True when the document declares a union of this (sanitized) name. */
  declaresUnion(name: string): boolean;
  /** Closure member only: the type of a reference field / member (`null`: not in the closure). Absent on the stand-alone path. */
  referenceType?(field: SuperSchemaField): string | null;
}

/**
 * Per-document state. A field-scoped enum is named `<Entity>_<field>`; two enum fields whose names sanitize
 * identically (`a-b` / `a_b`, or two non-ASCII names) would declare the same enum twice, so a later one gets a
 * numeric suffix. A shared enum of exactly that name is reused instead of redeclared.
 */
function createContext(model: SuperSchemaModel, referenceType?: (field: SuperSchemaField) => string | null): GenContext {
  const diagnostics: GeneratorDiagnostic[] = [];
  const entityName = model.entity.name;

  const sharedNames = new Set(
    (model.sharedEnums ?? []).filter((e) => normalizeEnumSymbols(e.values).length > 0).map((e) => sanitizeIdentifier(e.name))
  );
  const taken = new Set<string>([sanitizeIdentifier(entityName), ...sharedNames]);
  for (const group of [model.sharedEnums, model.customScalars, model.unionTypes, model.aliases, model.interfaces]) {
    for (const declared of group ?? []) taken.add(sanitizeIdentifier(declared.name));
  }

  const declaredUnions = new Set((model.unionTypes ?? []).map((u) => sanitizeIdentifier(u.name)));

  const names = new Map<SuperSchemaField, string>();
  const reused = new Set<SuperSchemaField>();
  const inlineValues = new Map<SuperSchemaField, string[]>();
  for (const field of model.fields) {
    if (!needsInlineEnum(field)) continue;
    inlineValues.set(field, normalizeEnumSymbols(extractEnumValues(field)));
    const base = `${sanitizeIdentifier(entityName)}_${sanitizeIdentifierSegment(field.name)}`;
    if (sharedNames.has(base)) {
      names.set(field, base);
      reused.add(field);
      continue;
    }
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    names.set(field, name);
  }

  return {
    entityName,
    diagnostics,
    ...(referenceType ? { referenceType } : {}),
    enumNameOf: (field) => names.get(field) ?? `${sanitizeIdentifier(entityName)}_${sanitizeIdentifierSegment(field.name)}`,
    // An enum without symbols is never declared (see generateFieldDefinition for how the field fails loudly).
    declaresInlineEnum: (field) => !reused.has(field) && (inlineValues.get(field)?.length ?? 0) > 0,
    declaresUnion: (name) => declaredUnions.has(sanitizeIdentifier(name)),
    hasNoEnumValues: (field) => !reused.has(field) && (inlineValues.get(field)?.length ?? 0) === 0,
  };
}

// ---------------------------------------------------------------------------
// Shared enum definition
// ---------------------------------------------------------------------------

function generateSharedEnumDefinition(sharedEnum: SuperSchemaSharedEnum, ctx: GenContext): string[] {
  const lines: string[] = [];
  const values = normalizeEnumSymbols(sharedEnum.values, (dup) =>
    ctx.diagnostics.push({
      severity: "warning",
      code: "ENUM_DUPLICATE_VALUE",
      message: `Shared enum "${sharedEnum.name}" lists the value "${dup}" more than once; the duplicate was dropped`,
    })
  );

  // An empty enum is unsatisfiable (`{ "enum": [] }` accepts nothing): never declare one.
  if (values.length === 0) {
    const message = `Shared enum "${sharedEnum.name}" has no values and was not emitted`;
    ctx.diagnostics.push({ severity: "warning", code: "ENUM_NO_VALUES", message });
    lines.push(`// ${message}`);
    return lines;
  }

  if (sharedEnum.description) {
    lines.push(`@doc("${escapeString(sharedEnum.description)}")`);
  }
  lines.push(`enum ${sanitizeIdentifier(sharedEnum.name)} {`);

  for (const val of values) {
    lines.push(`  ${enumMemberName(val)},`);
  }

  lines.push("}");
  return lines;
}

// ---------------------------------------------------------------------------
// Inline enum definition (field-scoped)
// ---------------------------------------------------------------------------

/**
 * Fields that get a field-scoped enum: every `enum` field, plus arrays / maps
 * whose element / value is an enum with known symbols.
 */
function needsInlineEnum(field: SuperSchemaField): boolean {
  if (field.type === "enum") return true;
  const member =
    field.type === "array"
      ? field.complexType?.arrayElementType
      : field.type === "map"
        ? field.complexType?.mapValueType
        : undefined;
  return member === "enum" && extractEnumValues(field).length > 0;
}

function generateInlineEnumDefinition(field: SuperSchemaField, ctx: GenContext): string[] {
  const enumName = ctx.enumNameOf(field);
  const lines: string[] = [];

  // Extract enum values from decorators or aliases
  const values = normalizeEnumSymbols(extractEnumValues(field), (dup) =>
    ctx.diagnostics.push({
      severity: "warning",
      code: "ENUM_DUPLICATE_VALUE",
      fieldName: field.name,
      message: `Enum field "${field.name}" lists the value "${dup}" more than once; the duplicate was dropped`,
    })
  );

  if (field.description) {
    lines.push(`@doc("${escapeString(field.description)}")`);
  }
  lines.push(`enum ${enumName} {`);

  for (const val of values) {
    lines.push(`  ${enumMemberName(val)},`);
  }

  lines.push("}");
  return lines;
}

/** Drop repeated symbols (a second `a` is a TypeSpec compile error), keeping first-seen order. */
function normalizeEnumSymbols(values: readonly string[], onDuplicate?: (value: string) => void): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      onDuplicate?.(value);
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** A pattern with regex constructs is a real regex, not an `A|B|C` symbol list. */
const REGEX_CONSTRUCT = /^\^|\$$|\\[dDwWsSbB]|[[\]()]|\.[*+]|\{\d/;

function extractEnumValues(field: SuperSchemaField): string[] {
  // Array element / map value enums carry their symbols in complexType.
  if (field.type !== "enum") {
    return field.complexType?.enumValues ?? [];
  }

  // Aliases hold the symbols verbatim (no separator ambiguity), so they win.
  if (field.aliases.length > 0) {
    return field.aliases;
  }

  // The importers carry an enum field's symbols in the pattern slot as "val1|val2|val3" (the generator never
  // emits @pattern for an enum, so the slot is free). Symbols may hold any character — hyphens, spaces — but a
  // value that is a regex (anchors, classes, groups) is not a symbol list.
  const validation = field.decorators.typespec?.validation;
  if (validation && "pattern" in validation && validation.pattern) {
    const pattern = validation.pattern;
    if (!REGEX_CONSTRUCT.test(pattern)) {
      return pattern.split("|").filter(Boolean);
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Custom scalar definition
// ---------------------------------------------------------------------------

function generateScalarDefinition(scalar: SuperSchemaCustomScalar): string[] {
  const lines: string[] = [];

  if (scalar.description) {
    lines.push(`@doc("${escapeString(scalar.description)}")`);
  }

  lines.push(`scalar ${sanitizeIdentifier(scalar.name)} extends ${scalar.baseType};`);
  return lines;
}

// ---------------------------------------------------------------------------
// Union definition
// ---------------------------------------------------------------------------

function generateUnionDefinition(union: SuperSchemaUnionType): string[] {
  const lines: string[] = [];

  if (union.description) {
    lines.push(`@doc("${escapeString(union.description)}")`);
  }

  // Always the block form: `union Name = A | B;` is not TypeSpec (the compiler expects `{`), only an alias takes `=`.
  lines.push(`union ${sanitizeIdentifier(union.name)} {`);
  for (const member of union.memberTypes) {
    lines.push(`  ${member},`);
  }
  lines.push("}");

  return lines;
}

// ---------------------------------------------------------------------------
// Interface definition
// ---------------------------------------------------------------------------

function generateInterfaceDefinition(iface: SuperSchemaInterface): string[] {
  const lines: string[] = [];

  if (iface.description) {
    lines.push(`@doc("${escapeString(iface.description)}")`);
  }

  lines.push(`interface ${sanitizeIdentifier(iface.name)} {`);

  for (const op of iface.operations) {
    lines.push(...generateOperationDefinition(op).map((l) => `  ${l}`));
  }

  lines.push("}");
  return lines;
}

// ---------------------------------------------------------------------------
// Operation definition
// ---------------------------------------------------------------------------

function generateOperationDefinition(op: SuperSchemaOperation): string[] {
  const lines: string[] = [];

  if (op.description) {
    lines.push(`@doc("${escapeString(op.description)}")`);
  }

  if (op.httpPath) {
    lines.push(`@route("${escapeString(op.httpPath)}")`);
  }

  if (op.httpMethod) {
    lines.push(`@${op.httpMethod.toLowerCase()}`);
  }

  // Build parameter list
  const paramParts: string[] = [];
  for (const param of op.parameters) {
    const locationDecorator = param.location !== "body" ? `@${param.location} ` : "";
    const optional = param.required ? "" : "?";
    paramParts.push(`${locationDecorator}${param.name}${optional}: ${param.type}`);
  }

  const paramStr = paramParts.join(", ");
  const returnType = op.responses.length > 0
    ? op.responses[0].type || "void"
    : "void";

  lines.push(`op ${sanitizeIdentifier(op.name)}(${paramStr}): ${returnType};`);
  return lines;
}

// ---------------------------------------------------------------------------
// Field definition
// ---------------------------------------------------------------------------

/**
 * True when the field is generated as `unknown`: it carries a dangling-reference marker AND its type still agrees with it
 * (`reference` for a direct reference, `array` for an item reference). A stale marker never produces `unknown`.
 */
function isDanglingField(field: SuperSchemaField): boolean {
  return activeDanglingRef(field.type, { danglingRef: field.danglingRef, arrayElementType: field.complexType?.arrayElementType }) !== undefined;
}

function generateFieldDefinition(
  field: SuperSchemaField,
  ctx: GenContext,
  governance: Governance
): string[] {
  const lines: string[] = [];

  // Field-level decorators
  lines.push(...generateFieldDecorators(field, governance));

  // Build the type expression
  let typeExpr: string;
  if (field.type === "enum" && ctx.hasNoEnumValues(field)) {
    // An empty enum would publish `{ "enum": [] }`, which no payload satisfies. Fail loudly instead: the type is an
    // identifier that cannot resolve, so the TypeSpec compile (Source tab, publish gate, emission) reports this
    // field with the message below rather than shipping a schema nobody can satisfy.
    const label = oneLine(`enum field ${JSON.stringify(field.name)} has no values; add at least one value`);
    ctx.diagnostics.push({
      severity: "error",
      code: "ENUM_NO_VALUES",
      fieldName: field.name,
      message: `Enum field "${field.name}" has no values; add at least one value`,
    });
    lines.push(`// ERROR: ${label}`);
    typeExpr = quoteIdentifier(`ERROR: ${label}`);
  } else {
    typeExpr = resolveTypeSpecType(field, ctx);
  }

  // Optionality (the property may be absent: `?`) and nullability (the value may be null: `| null`) are two things. A field that is nullable
  // because its value may be null (a JSON Schema `type: [T, "null"]`) says so in its type; one that must be present anyway (`required`) has
  // no `?`. Both need the field to be nullable at all: switching Nullable off writes the plain type. A dangling reference is `unknown`
  // carrying a raw `$ref`: no null to add.
  const nullType = field.nullable && field.nullableType === true && !isDanglingField(field);
  const optional = field.nullable && !(nullType && field.requiredNullable === true) ? "?" : "";
  if (nullType) typeExpr = `${typeExpr} | null`;

  // Default value
  const defaultClause = field.decorators.typespec?.identity?.defaultValue !== undefined
    ? ` = ${JSON.stringify(field.decorators.typespec.identity.defaultValue).replace(/\$\{/g, "\\${")}`
    : "";

  lines.push(`${propertyName(field.name)}${optional}: ${typeExpr}${defaultClause};`);

  return lines;
}

// ---------------------------------------------------------------------------
// Field decorators
// ---------------------------------------------------------------------------

/** The version a reference field (or an array / map of references) is pinned to; undefined when unpinned or not a reference. */
function fieldPin(field: SuperSchemaField): string | undefined {
  if (isDanglingField(field)) return undefined;
  const memberIsReference =
    field.type === "reference" ||
    (field.type === "array" && field.complexType?.arrayElementType === "reference") ||
    (field.type === "map" && field.complexType?.mapValueType === "reference");
  const reference = memberIsReference ? field.complexType?.reference : undefined;
  return reference?.pinnedVersion;
}

function generateFieldDecorators(field: SuperSchemaField, governance: Governance): string[] {
  const decorators: string[] = [];

  // @key
  if (field.isKey) {
    decorators.push("@key");
  }

  // @doc
  if (field.description) {
    decorators.push(`@doc("${escapeString(field.description)}")`);
  }

  // @secret (from typespec identity)
  if (field.decorators.typespec?.identity?.secret) {
    decorators.push("@secret");
  }

  // A dangling reference is generated as `unknown` / `unknown[]`. The real compiler rejects @format, @encode, @discriminator and the
  // string / numeric validators on it (decorator-wrong-target / invalid-encode); @key, @doc, @summary, @secret, @visibility, @example,
  // #deprecated, @encodedName and the extension decorators are fine (checked against the compiler). What is skipped here is not lost:
  // it stays in the field's decorators in the database and comes back when the reference is resolved.
  const unknownTyped = isDanglingField(field);

  // @discriminator
  if (field.decorators.typespec?.identity?.discriminator && !unknownTyped) {
    decorators.push(`@discriminator("${escapeString(field.name)}")`);
  }

  // @format (from typespec identity)
  if (field.decorators.typespec?.identity?.format && !unknownTyped) {
    decorators.push(`@format("${escapeString(field.decorators.typespec.identity.format)}")`);
  }

  // Validation decorators
  const validation = field.decorators.typespec?.validation;
  // A dangling reference is generated as `unknown`: only the array bounds of `unknown[]` are valid on it.
  const onUnknown = unknownTyped;
  const onlyItems = onUnknown && field.danglingRef?.element === true;
  if (validation && onUnknown) {
    if (onlyItems && validation.minItems != null) decorators.push(`@minItems(${validation.minItems})`);
    if (onlyItems && validation.maxItems != null) decorators.push(`@maxItems(${validation.maxItems})`);
  } else if (validation) {
    // Only validators the field's TypeSpec scalar accepts are written; the rest stay in the stored decorators (not deleted).
    const applies = (kind: ConstraintKind): boolean => constraintAppliesTo(field.type, kind);
    if (validation.minLength != null && applies("minLength")) {
      decorators.push(`@minLength(${validation.minLength})`);
    }
    if (validation.maxLength != null && applies("maxLength")) {
      decorators.push(`@maxLength(${validation.maxLength})`);
    }
    const bound = (kind: BoundKind, value: number | null | undefined): number | null => {
      const decorator = kind === "min" ? "minValue" : kind === "max" ? "maxValue" : kind === "minExclusive" ? "minValueExclusive" : "maxValueExclusive";
      return value == null || !applies(decorator) ? null : boundFor(field.type, kind, value);
    };
    const minValue = bound("min", validation.minValue);
    if (minValue !== null) decorators.push(`@minValue(${minValue})`);
    const maxValue = bound("max", validation.maxValue);
    if (maxValue !== null) decorators.push(`@maxValue(${maxValue})`);
    const minExclusive = bound("minExclusive", validation.minValueExclusive);
    if (minExclusive !== null) decorators.push(`@minValueExclusive(${minExclusive})`);
    const maxExclusive = bound("maxExclusive", validation.maxValueExclusive);
    if (maxExclusive !== null) decorators.push(`@maxValueExclusive(${maxExclusive})`);
    if (validation.pattern != null && field.type !== "enum" && applies("pattern")) {
      decorators.push(`@pattern("${escapeString(validation.pattern)}")`);
    }
    if (validation.minItems != null && applies("minItems")) {
      decorators.push(`@minItems(${validation.minItems})`);
    }
    if (validation.maxItems != null && applies("maxItems")) {
      decorators.push(`@maxItems(${validation.maxItems})`);
    }
  }

  // Wire format decorators
  const wireFormat = field.decorators.typespec?.wireFormat;
  if (wireFormat) {
    if (wireFormat.encode && !unknownTyped) {
      if (wireFormat.encodeSubType) {
        decorators.push(
          `@encode("${escapeString(wireFormat.encode)}", "${escapeString(wireFormat.encodeSubType)}")`
        );
      } else {
        decorators.push(`@encode("${escapeString(wireFormat.encode)}")`);
      }
    }
    if (wireFormat.encodedNames) {
      for (const [mime, name] of Object.entries(wireFormat.encodedNames)) {
        decorators.push(`@encodedName("${escapeString(mime)}", "${escapeString(name)}")`);
      }
    }
  }

  // Visibility decorators
  const visibility = field.decorators.typespec?.visibility;
  if (visibility?.phases && visibility.phases.length > 0) {
    const phaseList = visibility.phases
      .map((p) => `Lifecycle.${p}`)
      .join(", ");
    decorators.push(`@visibility(${phaseList})`);
  }

  // Documentation decorators
  const docs = field.decorators.typespec?.documentation;
  if (docs) {
    if (docs.summary) {
      decorators.push(`@summary("${escapeString(docs.summary)}")`);
    }
    if (docs.example != null) {
      decorators.push(`@example(${docs.example})`);
    }
    if (docs.deprecated) {
      decorators.push(`#deprecated "${escapeString(docs.deprecated)}"`);
    }
  }
  // A deprecated flag without a message (JSON Schema `deprecated: true`, the field panel's checkbox) lives in `evolution`; TypeSpec's
  // directive needs a message, so the flag is written with a plain one. The official emitters map it to `deprecated: true`.
  if (!docs?.deprecated && field.decorators.evolution?.deprecated === true) {
    decorators.push(`#deprecated "deprecated"`);
  }

  // Versioning decorators
  const versioning = field.decorators.typespec?.versioning;
  if (versioning) {
    if (versioning.added) {
      decorators.push(`@added(Versions.${sanitizeIdentifier(versioning.added)})`);
    }
    if (versioning.removed) {
      decorators.push(`@removed(Versions.${sanitizeIdentifier(versioning.removed)})`);
    }
  }

  // Classification (Story 16.6): the governance package's `@Enterprise.dataClassification`, or
  // `x-classification` for a level with no enum member — see governance-decorators.ts. Never `@tag`, which
  // real TypeSpec rejects on a model property (decorator-wrong-target).
  if (governance.enabled && field.classification) {
    decorators.push(classificationDecorator(field.classification, governance.enterpriseShadowed).line);
  }

  // Reference version pin: SuperSchema metadata of the canonical source, never part of an emission projection.
  const pin = fieldPin(field);
  if (governance.enabled && pin !== undefined) decorators.push(pinDecorator(pin));

  // Generic vendor extensions (unknown JSON Schema keys etc.) — a JsonSchema + OpenAPI pair per key.
  // (`x-super-schema-pin` is the pin tag only on a pinned reference; on any other field it is an ordinary extension.)
  decorators.push(
    ...genericExtensionDecorators(
      field.decorators.typespec?.extensions?.openapi,
      governance.enabled && pin !== undefined ? [PIN_EXTENSION_KEY] : []
    )
  );

  // A dangling `$ref` keeps its original string: `$ref` for a direct reference, `items: { $ref }` for an array's item type.
  // The extensions are applied after the emitter's own keys, so they replace the `unknown` / `items: {}` they stand for.
  if (field.danglingRef && unknownTyped) {
    const raw = `"${escapeTypeSpecString(field.danglingRef.ref)}"`;
    const args = field.danglingRef.element ? `"items", #{\`$ref\`: ${raw}}` : `"$ref", ${raw}`;
    decorators.push(`@TypeSpec.JsonSchema.extension(${args})`, `@TypeSpec.OpenAPI.extension(${args})`);
  }

  return decorators;
}

// ---------------------------------------------------------------------------
// Type resolution — LogicalType -> TypeSpec type expression
// ---------------------------------------------------------------------------

/** Structured logical types as a collection member (their `typespecScalar` is not a type). */
const STRUCTURED_MEMBER_TYPES: Record<string, string> = {
  object: "Record<unknown>",
  map: "Record<unknown>",
  array: "unknown[]",
};

/**
 * TypeSpec type of an array element / map value: a reference resolves to the
 * referenced entity, an enum to the field's generated enum, structured types to
 * their generic form; anything else as before (scalar, or a declared type name).
 */
function resolveCollectionMemberType(
  memberType: string,
  field: SuperSchemaField,
  ctx: GenContext
): string {
  if (memberType === "reference") {
    if (ctx.referenceType && field.complexType?.reference) return ctx.referenceType(field) ?? "unknown";
    const refName = field.complexType?.referencedEntityName;
    return refName ? sanitizeIdentifier(refName) : "string";
  }
  if (memberType === "enum") {
    return extractEnumValues(field).length > 0 ? ctx.enumNameOf(field) : "string";
  }
  if (memberType === "union") {
    return `(${resolveUnionType(field, ctx)})`.replace(/^\(([\w]+)\)$/, "$1");
  }
  if (STRUCTURED_MEMBER_TYPES[memberType]) {
    return STRUCTURED_MEMBER_TYPES[memberType];
  }
  return getTypeInfo(memberType)?.typespecScalar ?? memberType;
}

/**
 * A union-typed field: the declared union by name when the document declares it; otherwise the TypeSpec union
 * expression `A | B` from the members the field carries (the union row may be deselected, deleted, or never reach this
 * entity's source); `string` only when neither exists.
 */
function resolveUnionType(field: SuperSchemaField, ctx: GenContext): string {
  const unionName = field.complexType?.unionName;
  if (unionName && ctx.declaresUnion(unionName)) return sanitizeIdentifier(unionName);
  const members = field.complexType?.unionMembers;
  if (members && members.length > 0) return members.map((m) => sanitizeIdentifier(m)).join(" | ");
  return "string";
}

function resolveTypeSpecType(
  field: SuperSchemaField,
  ctx: GenContext
): string {
  if (isDanglingField(field)) return field.danglingRef?.element ? "unknown[]" : "unknown";
  const typeInfo = getTypeInfo(field.type);
  const typespecScalar = typeInfo?.typespecScalar ?? field.type;

  switch (field.type as LogicalType) {
    case "enum": {
      return ctx.enumNameOf(field);
    }
    case "array": {
      const elementType = field.complexType?.arrayElementType ?? "string";
      return `${resolveCollectionMemberType(elementType, field, ctx)}[]`;
    }
    case "map": {
      // TypeSpec `Record<T>` is string-keyed only (a key type argument does not
      // compile), so the key type stays in the IR (complexType.mapKeyType).
      const valueType = field.complexType?.mapValueType ?? "string";
      return `Record<${resolveCollectionMemberType(valueType, field, ctx)}>`;
    }
    case "object": {
      // Inline model or reference to a nested model
      return `Record<unknown>`;
    }
    case "reference": {
      // The canonical (stand-alone) text names the entity by its own name, qualified or not: it stays readable, and the qualified identity
      // (id, domain / product / entity) lives in the stored reference, which the Source tab save keeps while the text still says that name
      // (see `@/lib/references/source-reference`). A reader may also write `Domain.Product.Entity` there.
      const refName = field.complexType?.referencedEntityName;
      if (ctx.referenceType && field.complexType?.reference) return ctx.referenceType(field) ?? "unknown";
      if (refName) {
        return sanitizeIdentifier(refName);
      }
      return "string";
    }
    case "union": {
      return resolveUnionType(field, ctx);
    }
    case "decimal":
    case "decimal128": {
      return typespecScalar;
    }
    default: {
      return typespecScalar;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** The comment line {@link generateFieldDefinition} writes above a property whose enum has no values. */
const EMPTY_ENUM_COMMENT = /^[ \t]*\/\/ ERROR: enum field ("(?:[^"\\]|\\.)*") has no values/gm;

/**
 * The enum fields a generated source could not express (they have no values; see `ENUM_NO_VALUES`), read back from the
 * marker comment the generator leaves above each of them. Lets a consumer that only has the TEXT (the events renderer)
 * report the real cause instead of an opaque compiler failure.
 */
export function findEmptyEnumFields(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(EMPTY_ENUM_COMMENT)) {
    try {
      names.push(JSON.parse(match[1]) as string);
    } catch {
      names.push(match[1].slice(1, -1));
    }
  }
  return names;
}

function oneLine(text: string): string {
  return text.replace(new RegExp("[\\r\\n\\u2028\\u2029]+", "g"), " ");
}

function sanitizeNamespace(ns: string): string {
  // Namespace can have dots, so only sanitize each segment
  return ns
    .split(".")
    .map((segment) => sanitizeIdentifier(segment))
    .join(".");
}

