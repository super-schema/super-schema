/**
 * JSON Schema Importer — parses a JSON Schema document into entities.
 *
 * Reverse of the JSON Schema emission path: maps JSON Schema types + formats
 * back to SuperSchemaModel LogicalType values. This is the landing point for
 * the schema-onboarding flow:
 *
 *   paste sample JSON / paste JSON Schema / visual build (jsonjoy-builder)
 *     → JsonSchema document (JSON or YAML)
 *     → parseJsonSchemaDocument()   (this file)
 *     → entities + enums
 *     → review screen
 *     → createDomainAssetsFromImportAction → SuperSchemaModel → emitters
 *
 * Handles:
 * - Primitive types (string, integer, number, boolean) with format refinement
 * - Nullable via `required` membership and `type: [..., "null"]` unions
 * - String formats (date, date-time, time, duration, uri, uuid, email, ...)
 * - Validation constraints (minLength/maxLength/pattern/minimum/maximum/items)
 * - Inline enum / const: string values import as a (single-member, for `const`) enum that keeps every symbol
 *   verbatim. The enum IR holds string symbols only, so a numeric / boolean / mixed enum or const maps to the
 *   best-fit primitive at LOW confidence (numeric ranges become min/max) — never to an enum with no values,
 *   which would publish an unsatisfiable `{ "enum": [] }`.
 * - `$defs` / `definitions`: object entries become entities (named by their
 *   key, which is what `$ref` points at), enum entries become shared enums,
 *   any other entry is inlined into the fields that reference it
 * - `$ref` → `reference` to the defined entity (`#` → the root entity); an
 *   unresolved `$ref` stays a low-confidence reference by name (an entity
 *   that already exists in the catalog, as the visual builder emits)
 * - Arrays (element type / element reference), combinators (lower confidence)
 *
 * Inline nested objects (not `$ref`) are NOT expanded into child entities —
 * they map to the `object` logical type, flagged low confidence.
 *
 * `parseJsonSchema()` keeps the single-entity contract: the root entity.
 */

import { parse as parseYaml } from "yaml";
import { collidingFieldNames } from "@/lib/typespec-official/name-collisions";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import { setOwn } from "@/lib/compiler/governance-decorators";
import { getClassificationConfig, type ClassificationConfig } from "./classification-config";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { constraintAppliesTo, type ConstraintKind } from "@/lib/compiler/constraint-targets";
import { pickRootEntity } from "./multi-asset";
import type {
  ParsedEntity,
  ParsedEnum,
  ParsedField,
  ParsedFieldConstraint,
  ImportConfidence,
  MultiEntityImportResult,
  ParsedUnion,
} from "./types";
import { IMPORTED_ENTITY_FALLBACK_NAME } from "./types";

export { IMPORTED_ENTITY_FALLBACK_NAME };

// ---------------------------------------------------------------------------
// Minimal JSON Schema shape (we only read the keywords we map)
// ---------------------------------------------------------------------------

interface JsonSchemaNode {
  $schema?: string;
  $id?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode | JsonSchemaNode[];
  enum?: unknown[];
  const?: unknown;
  deprecated?: boolean;
  default?: unknown;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  // validation
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  [key: string]: unknown;
}

/**
 * Keywords the importer reads (the `JsonSchemaNode` fields) plus `x-tags` / `x-classification`, which have their
 * own round-trips. Every other key is kept verbatim as an extension.
 */
const KNOWN_SCHEMA_KEYWORDS = new Set([
  "$schema", "$id", "$ref", "title", "description", "type", "format", "properties", "required", "items",
  "enum", "const", "deprecated", "oneOf", "anyOf", "allOf", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "$defs", "definitions",
  "x-tags", "x-classification",
]);

/**
 * Standard JSON Schema (2020-12 / draft-07) keywords the importer recognizes but maps to nothing in the IR. They are
 * listed in `ignoredKeywords` (not used by the app) + a warning, AND kept verbatim in `extensions` so a re-export loses
 * nothing. Keywords the importer consumes in any path (type, format, enum, const, constraints, ...) are never in this
 * set. (`default` is not consumed anywhere, so it is listed and preserved too.)
 */
const IGNORED_SCHEMA_KEYWORDS = new Set([
  "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "dependencies",
  "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor",
  "unevaluatedProperties", "unevaluatedItems", "patternProperties", "propertyNames",
  "additionalProperties", "additionalItems", "contains", "minContains", "maxContains", "prefixItems",
  "multipleOf", "uniqueItems", "minProperties", "maxProperties",
  "contentEncoding", "contentMediaType", "contentSchema", "readOnly", "writeOnly",
  "examples", "example", "$comment", "$anchor", "$vocabulary", "default",
]);

/** Read by the importer on an entity node (names it) but unused on a field node, where it is listed as ignored and preserved. */
const FIELD_ONLY_IGNORED = new Set(["title", "$schema", "$id", "$defs", "definitions"]);

/** Ignored standard keywords present on `node` (document order, deduplicated); `isField` adds the field-only ones. */
function ignoredKeywordsOf(nodes: JsonSchemaNode[], isField: boolean, nested: JsonSchemaNode[] = []): string[] | undefined {
  const found = new Set<string>();
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      if (IGNORED_SCHEMA_KEYWORDS.has(key) || (isField && FIELD_ONLY_IGNORED.has(key))) found.add(key);
    }
  }
  for (const node of nested) {
    for (const key of Object.keys(node)) if (IGNORED_SCHEMA_KEYWORDS.has(key)) found.add(key);
  }
  return found.size > 0 ? [...found] : undefined;
}

/** Object schemas directly under `items` / `oneOf` / `anyOf` of the given sources (one level; not recursive). */
function nestedSchemas(sources: JsonSchemaNode[]): JsonSchemaNode[] {
  const out: JsonSchemaNode[] = [];
  for (const source of sources) {
    if (isSchemaObject(source.items)) out.push(source.items as JsonSchemaNode);
    for (const list of [source.oneOf, source.anyOf]) {
      if (!Array.isArray(list)) continue;
      for (const member of list) if (isSchemaObject(member)) out.push(member);
    }
  }
  return out;
}

/** Every key of `node` the importer does not read, verbatim (parsed JSON values); `undefined` when none. */
function captureExtensions(node: JsonSchemaNode, isField = false): Record<string, unknown> | undefined {
  let captured: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(node)) {
    if (KNOWN_SCHEMA_KEYWORDS.has(key) && !(isField && FIELD_ONLY_IGNORED.has(key))) continue;
    setOwn((captured ??= {}), key, value);
  }
  return captured;
}

// ---------------------------------------------------------------------------
// allOf: flatten members (JSON Schema 2020-12 §10.2.1 — every member applies)
// ---------------------------------------------------------------------------

function isSchemaObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every object member of `node.allOf`, in document order, with nested `allOf`s flattened. Non-object members
 * (null, booleans, arrays, numbers) are skipped. Recursion stops at MAX_SCHEMA_NESTING (`truncated`) so a hostile
 * document cannot nest `allOf` without limit.
 */
function flattenAllOf(node: JsonSchemaNode): { members: JsonSchemaNode[]; truncated: boolean } {
  const members: JsonSchemaNode[] = [];
  let truncated = false;
  const walk = (current: JsonSchemaNode, depth: number): void => {
    if (!Array.isArray(current.allOf)) return;
    if (depth >= MAX_SCHEMA_NESTING) {
      truncated = true;
      return;
    }
    for (const member of current.allOf) {
      if (!isSchemaObject(member)) continue;
      members.push(member);
      walk(member, depth + 1);
    }
  };
  walk(node, 0);
  return { members, truncated };
}

/** `node` plus its flattened `allOf` members (a sibling oneOf / anyOf does not hide them: every allOf member still applies). */
function schemaSources(node: JsonSchemaNode): JsonSchemaNode[] {
  if (!Array.isArray(node.allOf)) return [node];
  return [node, ...flattenAllOf(node).members];
}

/** Whether a schema fixes the TYPE of a value (as opposed to only constraining / annotating it). */
function definesType(node: JsonSchemaNode): boolean {
  if (typeof node.$ref === "string" || node.const !== undefined || Array.isArray(node.enum)) return true;
  if (node.oneOf || node.anyOf || node.properties || node.items) return true;
  const { base } = normalizeType(node.type);
  return base !== undefined && base !== "null";
}

function withoutAllOf(node: JsonSchemaNode): JsonSchemaNode {
  return { ...node, allOf: undefined };
}

// ---------------------------------------------------------------------------
// JSON Schema string `format` → logical type (high-confidence refinements)
// ---------------------------------------------------------------------------

const STRING_FORMAT_MAP: Record<string, { type: string; confidence: ImportConfidence; keepFormat?: boolean }> = {
  date: { type: "plainDate", confidence: "high" },
  time: { type: "plainTime", confidence: "high" },
  "date-time": { type: "utcDateTime", confidence: "high" },
  duration: { type: "duration", confidence: "high" },
  uri: { type: "url", confidence: "high" },
  url: { type: "url", confidence: "high" },
  "uri-reference": { type: "url", confidence: "medium" },
  iri: { type: "url", confidence: "medium" },
  // Formats with no dedicated logical type — stay `string`, keep the format hint
  uuid: { type: "string", confidence: "high", keepFormat: true },
  email: { type: "string", confidence: "high", keepFormat: true },
  "idn-email": { type: "string", confidence: "medium", keepFormat: true },
  hostname: { type: "string", confidence: "high", keepFormat: true },
  ipv4: { type: "string", confidence: "high", keepFormat: true },
  ipv6: { type: "string", confidence: "high", keepFormat: true },
  byte: { type: "bytes", confidence: "medium" },
  binary: { type: "bytes", confidence: "medium" },
};

// JSON Schema numeric `format` → logical type
const INTEGER_FORMAT_MAP: Record<string, { type: string; confidence: ImportConfidence }> = {
  int8: { type: "int8", confidence: "high" },
  int16: { type: "int16", confidence: "high" },
  int32: { type: "int32", confidence: "high" },
  int64: { type: "int64", confidence: "high" },
  uint8: { type: "uint8", confidence: "high" },
  uint16: { type: "uint16", confidence: "high" },
  uint32: { type: "uint32", confidence: "high" },
  uint64: { type: "uint64", confidence: "high" },
  "unix-timestamp": { type: "unixTimestamp32", confidence: "medium" },
};

const NUMBER_FORMAT_MAP: Record<string, { type: string; confidence: ImportConfidence }> = {
  float: { type: "float32", confidence: "high" },
  float32: { type: "float32", confidence: "high" },
  double: { type: "float64", confidence: "high" },
  float64: { type: "float64", confidence: "high" },
  decimal: { type: "decimal", confidence: "high" },
};

// ---------------------------------------------------------------------------
// Resolve a property node → logical type + metadata
// ---------------------------------------------------------------------------

interface ResolvedType {
  type: string;
  confidence: ImportConfidence;
  nullable: boolean;
  originalType: string;
  format?: string;
  referencedEntityName?: string;
  enumName?: string;
  enumValues?: string[];
  unionName?: string;
  unionMembers?: string[];
  /** Constraints implied by the resolution itself (a numeric `const` / `enum` becomes a min/max range). */
  impliedConstraints?: ParsedFieldConstraint[];
  /** True when the low confidence comes ONLY from an unresolved external `$ref` (not an allOf conflict, a combinator, ...). */
  lowFromUnresolvedRef?: boolean;
}

/** Fields whose low confidence is solely due to an unresolved external `$ref` (URL import raises it once the ref resolves). */
const LOW_FROM_UNRESOLVED_REF = new WeakSet<object>();
/** The item's original $ref of an array-of-reference field (field.originalType is "array" there). */
const ARRAY_ITEM_REF = new WeakMap<object, string>();
export function isLowFromUnresolvedRef(field: object): boolean {
  return LOW_FROM_UNRESOLVED_REF.has(field);
}

/** One `$defs` / `definitions` entry, keyed by its local JSON pointer. */
interface DefinitionEntry {
  key: string;
  node: JsonSchemaNode;
  kind: "entity" | "enum" | "union" | "inline";
  /** Asset name (entities / enums / unions) — the key, made unique against the root entity. */
  assetName: string;
}

interface ResolveContext {
  definitions: Map<string, DefinitionEntry>;
  /** Root entity name when the document root is itself an object schema (target of `$ref: "#"`). */
  rootEntityName?: string;
  /** Guards `$ref` chains through inline definitions. */
  depth: number;
  /** Guards nested combinators (`oneOf` inside `oneOf` …) — a hostile document can nest them without limit. */
  nesting: number;
  /** Every asset name in use (entities, enums, unions): generated union names are made unique against it. */
  taken: Set<string>;
  /** Unions created while resolving fields (shared `$defs` unions are added by the document loop). */
  unions: ParsedUnion[];
  warnings: string[];
  /** One union per combinator node, however many times the node is resolved. */
  unionByNode: WeakMap<object, string>;
  /** Members of each shared `$defs` union by asset name (a field referencing it carries them too). */
  sharedUnionMembers: Map<string, string[]>;
  /** Shared `$defs` unions (by asset name) with a member that names nothing in this document: a field using one is low confidence. */
  unresolvedSharedUnions?: Set<string>;
  /** `<Entity>_<field>` the node being resolved belongs to — the stem of a generated union name. */
  unionStem?: string;
}

/** A union with more members than this is not a real schema; the excess is dropped (and reported). */
export const MAX_UNION_MEMBERS = 200;

/** Entity and field names above this length are not imported (the emitters write a file per declaration). */
export const MAX_IMPORTED_NAME_LENGTH = 128;

/** One import carries at most this many entities (and, separately, enums); more is not a real schema set and floods the response. */
export const MAX_IMPORT_ENTITIES = 500;

/** `originalContent` is copied onto every entity of a document; past this many characters in total only the first entity per document keeps it. */
export const MAX_ORIGINAL_CONTENT_TOTAL = 1_000_000;

/** The error message when an import has too many entities or enums, or undefined when it is within the cap. */
export function importCountLimitMessage(entityCount: number, enumCount: number): string | undefined {
  if (entityCount > MAX_IMPORT_ENTITIES) return `The schema defines ${entityCount} entities; one import is limited to ${MAX_IMPORT_ENTITIES}.`;
  if (enumCount > MAX_IMPORT_ENTITIES) return `The schema defines ${enumCount} enums; one import is limited to ${MAX_IMPORT_ENTITIES}.`;
  return undefined;
}

/**
 * Keeps the per-entity copy of the source document within a total-size budget. Under the budget nothing changes; over it, only the
 * first entity of each distinct document keeps `originalContent` (the rest get "") and a warning says so.
 */
export function budgetOriginalContent(entities: ParsedEntity[], warnings: string[]): void {
  let total = 0;
  for (const e of entities) total += e.originalContent.length;
  if (total <= MAX_ORIGINAL_CONTENT_TOTAL) return;
  const seen = new Set<string>();
  for (const e of entities) {
    if (seen.has(e.originalContent)) e.originalContent = "";
    else seen.add(e.originalContent);
  }
  warnings.push("The schema is large; the original source text is kept on the first entity of each document only.");
}

const MAX_REF_DEPTH = 16;
/** Combinator nesting past this is not a real schema; resolve it as an unknown at low confidence. */
export const MAX_SCHEMA_NESTING = 200;

/** Every symbol of an `enum` / `const` is a string (nulls aside) — the only shape the enum IR carries. */
function isStringEnum(values: unknown[]): boolean {
  const symbols = values.filter((v) => v !== null);
  return symbols.length > 0 && symbols.every((v) => typeof v === "string");
}

/**
 * Resolve the values of an `enum` / `const`.
 *
 * - all strings (null aside) → an enum with those symbols, verbatim;
 * - all numbers → `integer` / `float64` at low confidence, the range kept as min/max;
 * - booleans → `boolean`;
 * - anything else (mixed, objects, nothing but null) → `string` at low confidence.
 *
 * It never returns an enum without symbols: that would publish an unsatisfiable `{ "enum": [] }`.
 */
function resolveLiteralValues(values: unknown[], originalType: string): ResolvedType {
  const nullable = values.includes(null);
  const symbols = values.filter((v) => v !== null);

  if (isStringEnum(values)) {
    const unique = [...new Set(symbols as string[])];
    // Symbols travel as "A|B|C" (the generator reads them back from the pattern slot), so one that holds the
    // separator, or is empty, cannot round-trip: flag it rather than silently splitting it.
    const lossy = unique.some((s) => s === "" || s.includes("|"));
    return { type: "enum", confidence: lossy ? "low" : "high", nullable, originalType, enumValues: unique };
  }

  if (symbols.length > 0 && symbols.every((v) => typeof v === "number" && Number.isFinite(v))) {
    const numbers = symbols as number[];
    return {
      type: numbers.every(Number.isInteger) ? "integer" : "float64",
      confidence: "low",
      nullable,
      originalType,
      impliedConstraints: [
        { type: "minValue", value: Math.min(...numbers) },
        { type: "maxValue", value: Math.max(...numbers) },
      ],
    };
  }

  if (symbols.length > 0 && symbols.every((v) => typeof v === "boolean")) {
    const both = new Set(symbols).size === 2;
    return { type: "boolean", confidence: both ? "high" : "low", nullable, originalType };
  }

  return { type: "string", confidence: "low", nullable, originalType };
}

/** Split a `type` keyword into its non-null base + whether "null" was present. */
function normalizeType(type: string | string[] | undefined): {
  base: string | undefined;
  nullableFromType: boolean;
} {
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    return {
      base: nonNull[0],
      nullableFromType: type.includes("null"),
    };
  }
  return { base: type, nullableFromType: false };
}

/** An external reference (a file or URL), as opposed to a `#/...` pointer, which names an entity that must already exist. */
function isExternalRef(ref: string): boolean {
  return ref !== "" && !ref.startsWith("#");
}

const DANGLING_REASON = "not defined in this document (kept as a dangling reference)";

/**
 * An in-document pointer with its escapes undone (RFC 6901 in a URI fragment): each segment is percent-decoded, then `~1` -> `/` and
 * `~0` -> `~`, so `#/$defs/a~1b` names the definition keyed `a/b`. The definitions are indexed by their raw key. A malformed percent
 * escape leaves the ref as written (it then reads as unresolved, never throws).
 */
function decodePointer(ref: string): string {
  if (!ref.startsWith("#/")) return ref;
  try {
    return `#/${ref
      .slice(2)
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~"))
      .join("/")}`;
  } catch {
    return ref;
  }
}

/** `$id` -> entry, per index (an index is never mutated after `indexDefinitions` returns). */
const ID_INDEXES = new WeakMap<Map<string, DefinitionEntry>, Map<string, DefinitionEntry>>();

/**
 * The definition a `$ref` names: the `#/$defs/Foo` pointer, or the `$id` of an embedded `$defs` resource. A bundled document (this app's
 * own JSON Schema output) lists every declaration under `$defs` with a `$id` and points at it by that `$id` (`"$ref": "Foo.json"`), which
 * is how a compound document names an embedded resource; without this it read as a reference to a missing file.
 */
function definitionFor(definitions: Map<string, DefinitionEntry>, ref: string): DefinitionEntry | undefined {
  const byPointer = definitions.get(ref) ?? definitions.get(decodePointer(ref));
  if (byPointer || ref.startsWith("#")) return byPointer;
  let byId = ID_INDEXES.get(definitions);
  if (!byId) {
    byId = new Map();
    for (const entry of definitions.values()) {
      const id = (entry.node as { $id?: unknown }).$id;
      if (typeof id === "string" && id !== "" && !byId.has(id)) byId.set(id, entry);
    }
    ID_INDEXES.set(definitions, byId);
  }
  return byId.get(ref);
}

function resolveRef(ref: string, ctx: ResolveContext): ResolvedType {
  if ((ref === "#" || ref === "") && ctx.rootEntityName) {
    return {
      type: "reference",
      confidence: "high",
      nullable: false,
      originalType: ref,
      referencedEntityName: ctx.rootEntityName,
    };
  }

  const def = definitionFor(ctx.definitions, ref);
  if (def?.kind === "entity") {
    return {
      type: "reference",
      confidence: "high",
      nullable: false,
      originalType: ref,
      referencedEntityName: def.assetName,
    };
  }
  if (def?.kind === "enum") {
    const values = (def.node.enum ?? []).filter((v) => v !== null) as string[];
    return {
      type: "enum",
      confidence: "high",
      nullable: (def.node.enum ?? []).includes(null),
      originalType: ref,
      enumName: def.assetName,
      enumValues: [...new Set(values)],
    };
  }
  if (def?.kind === "union") {
    return {
      type: "union",
      confidence: ctx.unresolvedSharedUnions?.has(def.assetName) ? "low" : "medium",
      nullable: false,
      originalType: ref,
      unionName: def.assetName,
      ...(ctx.sharedUnionMembers.get(def.assetName) ? { unionMembers: ctx.sharedUnionMembers.get(def.assetName) } : {}),
    };
  }
  if (def?.kind === "inline" && ctx.depth < MAX_REF_DEPTH) {
    return resolveSchemaType(def.node, { ...ctx, depth: ctx.depth + 1 });
  }

  // Not defined in this document: a reference by name to an entity that must
  // already exist (the visual builder emits `#/$defs/<Existing>`).
  return {
    type: "reference",
    confidence: "low",
    nullable: false,
    originalType: ref,
    referencedEntityName: refToEntityName(ref),
    lowFromUnresolvedRef: true,
  };
}

/** Name of the named asset a `$ref` member of a union points at; `undefined` when it names no entity / enum. */
function unionMemberName(ref: string, ctx: ResolveContext): string | undefined {
  if (ref === "#" || ref === "") return ctx.rootEntityName === undefined ? undefined : sanitizeIdentifier(ctx.rootEntityName);
  const def = definitionFor(ctx.definitions, ref);
  // Members are spelled the way the generator spells the models / enums they name (sanitizeIdentifier), so the
  // emitted `union` / `A | B` expression refers to declarations that exist.
  if (def) return def.kind === "entity" || def.kind === "enum" ? sanitizeIdentifier(def.assetName) : undefined;
  const name = refToEntityName(ref);
  return name === "" || name === "#" ? undefined : sanitizeIdentifier(name);
}

/** A null member of a combinator: `{ type: "null" }` (nothing else). */
function isNullMember(m: unknown): boolean {
  return isSchemaObject(m) && typeof m.$ref !== "string" && normalizeType(m.type).base === "null";
}

/**
 * The member names of a `oneOf` / `anyOf` whose every non-null member is a `$ref` to a named entity / enum
 * (in-document, or external and unresolved), deduplicated in order. `undefined` when any member is something else
 * (a primitive, an inline object, a boolean schema, a ref to an inline definition) or fewer than two names remain —
 * the caller keeps its first-member fallback then, never a partial union.
 */
function namedRefMembers(raw: unknown[], ctx: ResolveContext): { names: string[]; hasNull: boolean } | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  let hasNull = false;
  for (const m of raw) {
    if (isNullMember(m)) {
      hasNull = true;
      continue;
    }
    if (!isSchemaObject(m) || typeof m.$ref !== "string") return undefined;
    const name = unionMemberName(m.$ref, ctx);
    if (name === undefined) return undefined;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names.length >= 2 ? { names, hasNull } : undefined;
}

/** `$ref`s of the members of a combinator that name nothing in this document (an external file / URL, or a missing pointer). */
function unresolvedMemberRefs(raw: unknown[], ctx: ResolveContext): string[] {
  const refs: string[] = [];
  for (const m of raw) {
    if (!isSchemaObject(m) || typeof m.$ref !== "string" || m.$ref === "#" || m.$ref === "") continue;
    if (!definitionFor(ctx.definitions, m.$ref) && !refs.includes(m.$ref)) refs.push(m.$ref);
  }
  return refs;
}

function unresolvedUnionWarning(unionName: string, refs: string[]): string {
  return `Union \`${unionName}\` has members that are not defined in this document (${refs.join(", ")}); they stay as unresolved names and the union is low confidence.`;
}

/** Cap the member list, reporting what was dropped. */
function boundMembers(names: string[], label: string, warnings: string[]): string[] {
  if (names.length <= MAX_UNION_MEMBERS) return names;
  warnings.push(`Union "${label}" has ${names.length} members; only the first ${MAX_UNION_MEMBERS} are kept (${names.length - MAX_UNION_MEMBERS} dropped).`);
  return names.slice(0, MAX_UNION_MEMBERS);
}

/**
 * A name not in `taken` (suffixing `_2`, `_3`, …); marks it taken. `taken` holds the SANITIZED spelling (what the
 * generator emits), so `page-size` and `page_size` cannot both claim one TypeSpec name.
 */
function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(sanitizeIdentifier(name)); n++) name = `${base}_${n}`;
  taken.add(sanitizeIdentifier(name));
  return name;
}

/** A property-level `oneOf` / `anyOf` of named refs → a generated union (once per node), or `undefined`. */
function resolveNamedRefUnion(
  node: JsonSchemaNode,
  keyword: string,
  raw: unknown[],
  ctx: ResolveContext
): ResolvedType | undefined {
  const found = namedRefMembers(raw, ctx);
  if (!found) return undefined;
  const unresolved = unresolvedMemberRefs(raw, ctx);
  let name = ctx.unionByNode.get(node);
  if (name === undefined) {
    name = uniqueName(`${sanitizeIdentifier(ctx.unionStem ?? "Anonymous")}_Union`, ctx.taken);
    ctx.unionByNode.set(node, name);
    ctx.unions.push({ name, memberTypes: boundMembers(found.names, name, ctx.warnings) });
    if (unresolved.length > 0) ctx.warnings.push(unresolvedUnionWarning(name, unresolved));
  }
  const memberTypes = ctx.unions.find((u) => u.name === name)?.memberTypes;
  return {
    type: "union",
    confidence: unresolved.length > 0 ? "low" : "medium",
    nullable: found.hasNull,
    originalType: `${keyword}(${found.names.length})`,
    unionName: name,
    ...(memberTypes ? { unionMembers: memberTypes } : {}),
  };
}

function resolveSchemaType(node: JsonSchemaNode, ctx: ResolveContext): ResolvedType {
  if (typeof node.$ref === "string") {
    return resolveRef(node.$ref, ctx);
  }

  // const → a fixed single-value enum (CloudEvents `specversion: { "const": "1.0" }`)
  if (node.const !== undefined) {
    return resolveLiteralValues([node.const], `const(${JSON.stringify(node.const)})`);
  }

  // enum → logical enum
  if (Array.isArray(node.enum)) {
    return resolveLiteralValues(node.enum, `enum(${node.enum.map((v) => JSON.stringify(v)).join(",")})`);
  }

  // allOf → intersection of every member (resolveAllOf); oneOf / anyOf below
  if (Array.isArray(node.allOf) && !node.oneOf && !node.anyOf) return resolveAllOf(node, ctx);

  // Combinators → take the first non-null member, medium/low confidence
  const rawCombinator = node.oneOf ?? node.anyOf;
  // `oneOf: [null]` / boolean schemas carry no type: only object members are read.
  const combinator = Array.isArray(rawCombinator)
    ? rawCombinator.filter((m): m is JsonSchemaNode => typeof m === "object" && m !== null && !Array.isArray(m))
    : [];
  if (combinator.length > 0) {
    const keyword = node.oneOf ? "oneOf" : "anyOf";
    if (ctx.nesting >= MAX_SCHEMA_NESTING) {
      return { type: "string", confidence: "low", nullable: false, originalType: `${keyword}(nested too deeply)` };
    }
    const union = resolveNamedRefUnion(node, keyword, rawCombinator as unknown[], ctx);
    if (union) return union;
    const nonNull = combinator.filter(
      (m) => !(m && normalizeType(m.type).base === undefined && normalizeType(m.type).nullableFromType) && normalizeType(m.type).base !== "null"
    );
    const members = nonNull.length > 0 ? nonNull : combinator;
    const hasNull = combinator.some((m) => normalizeType(m.type).base === "null" || normalizeType(m.type).nullableFromType);
    const first = resolveSchemaType(members[0], { ...ctx, nesting: ctx.nesting + 1 });
    return {
      ...first,
      confidence: members.length === 1 ? first.confidence : "low",
      nullable: hasNull || first.nullable,
      originalType: `${keyword}(${members.length})`,
      lowFromUnresolvedRef: members.length === 1 && first.lowFromUnresolvedRef === true,
    };
  }

  const { base, nullableFromType } = normalizeType(node.type);

  switch (base) {
    case "string": {
      const fmt = node.format ? STRING_FORMAT_MAP[node.format] : undefined;
      if (fmt) {
        return {
          type: fmt.type,
          confidence: fmt.confidence,
          nullable: nullableFromType,
          originalType: `string/${node.format}`,
          format: fmt.keepFormat ? node.format : undefined,
        };
      }
      return {
        type: "string",
        confidence: "high",
        nullable: nullableFromType,
        originalType: node.format ? `string/${node.format}` : "string",
        format: node.format,
      };
    }
    case "integer": {
      const fmt = node.format ? INTEGER_FORMAT_MAP[node.format] : undefined;
      return {
        type: fmt?.type ?? "integer",
        confidence: fmt?.confidence ?? "high",
        nullable: nullableFromType,
        originalType: node.format ? `integer/${node.format}` : "integer",
      };
    }
    case "number": {
      const fmt = node.format ? NUMBER_FORMAT_MAP[node.format] : undefined;
      return {
        type: fmt?.type ?? "float64",
        confidence: fmt ? fmt.confidence : "medium",
        nullable: nullableFromType,
        originalType: node.format ? `number/${node.format}` : "number",
      };
    }
    case "boolean":
      return { type: "boolean", confidence: "high", nullable: nullableFromType, originalType: "boolean" };
    case "array":
      return { type: "array", confidence: "medium", nullable: nullableFromType, originalType: "array" };
    case "object":
      return { type: "object", confidence: "low", nullable: nullableFromType, originalType: "object" };
    case "null":
      return { type: "string", confidence: "low", nullable: true, originalType: "null" };
    default:
      // No `type` keyword but has properties → treat as nested object
      if (node.properties) {
        return { type: "object", confidence: "low", nullable: nullableFromType, originalType: "object" };
      }
      return { type: "string", confidence: "low", nullable: nullableFromType, originalType: "unknown" };
  }
}

/**
 * `allOf` on a property / value: the value must satisfy EVERY member, so the members merge instead of competing.
 * - the TYPE comes from the members that define one (a `$ref` member wins over an inline one; the first otherwise);
 *   members that define conflicting types keep the first at low confidence (the IR cannot hold an unsatisfiable type);
 * - constraint-only members (`minLength`, `maxLength`, …) contribute no type — their constraints are unioned by
 *   `buildFields` (see `schemaSources`), as are the annotation-only members' description / extensions.
 */
function resolveAllOf(node: JsonSchemaNode, ctx: ResolveContext): ResolvedType {
  if (ctx.nesting >= MAX_SCHEMA_NESTING) {
    return { type: "string", confidence: "low", nullable: false, originalType: "allOf(nested too deeply)" };
  }
  const { members, truncated } = flattenAllOf(node);
  const sources = [node, ...members];
  const hasNull = sources.some((m) => {
    const t = normalizeType(m.type);
    return t.base === "null" || t.nullableFromType;
  });
  const defining = sources.filter(definesType);
  const label = `allOf(${members.length})`;
  const child = { ...ctx, nesting: ctx.nesting + 1 };

  if (defining.length === 0) {
    // Constraint-only members: infer the base type from the keywords they carry.
    const keys = sources.flatMap((m) => Object.keys(m));
    const inferred = keys.some((k) => k === "minLength" || k === "maxLength" || k === "pattern" || k === "format")
      ? "string"
      : keys.some((k) => k.includes("imum") || k === "multipleOf")
        ? "number"
        : undefined;
    const base = resolveSchemaType(inferred ? { type: inferred } : {}, child);
    return { ...base, nullable: hasNull, originalType: label, confidence: truncated || !inferred ? "low" : "medium" };
  }

  const primaryNode = defining.find((m) => typeof m.$ref === "string") ?? defining[0];
  const primary = resolveSchemaType(withoutAllOf(primaryNode), child);
  let conflict = truncated;
  for (const other of defining) {
    if (other === primaryNode) continue;
    const resolved = resolveSchemaType(withoutAllOf(other), child);
    // `$ref` + an inline `{ type: "object" }` is the usual "reference, refined" shape, not a conflict.
    if (primary.type === "reference" && resolved.type === "object") continue;
    if (
      resolved.type !== primary.type ||
      resolved.referencedEntityName !== primary.referencedEntityName ||
      resolved.enumName !== primary.enumName
    ) {
      conflict = true;
    }
  }
  return {
    ...primary,
    confidence: conflict ? "low" : primary.confidence,
    nullable: hasNull || primary.nullable,
    originalType: label,
    lowFromUnresolvedRef: !conflict && primary.lowFromUnresolvedRef === true,
  };
}

// ---------------------------------------------------------------------------
// Extract validation constraints into ParsedField shape
// ---------------------------------------------------------------------------

function extractConstraints(node: JsonSchemaNode): {
  constraints: ParsedFieldConstraint[];
  minValueExclusive?: number;
  maxValueExclusive?: number;
} {
  const constraints: ParsedFieldConstraint[] = [];
  // Keys below map 1:1 onto ValidationDecorators via buildDecoratorsFromParsedField.
  if (typeof node.minLength === "number") constraints.push({ type: "minLength", value: node.minLength });
  if (typeof node.maxLength === "number") constraints.push({ type: "maxLength", value: node.maxLength });
  if (typeof node.pattern === "string") constraints.push({ type: "pattern", value: node.pattern });
  if (typeof node.minimum === "number") constraints.push({ type: "minValue", value: node.minimum });
  if (typeof node.maximum === "number") constraints.push({ type: "maxValue", value: node.maximum });
  if (typeof node.minItems === "number") constraints.push({ type: "minItems", value: node.minItems });
  if (typeof node.maxItems === "number") constraints.push({ type: "maxItems", value: node.maxItems });

  return {
    constraints,
    minValueExclusive: typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum : undefined,
    maxValueExclusive: typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum : undefined,
  };
}

/** "#/$defs/Customer" → "Customer"; "https://x/Order.json" → "Order"; "Card" → "Card". */
export function refToEntityName(ref: string): string {
  const last = ref.split(/[/#]/).filter(Boolean).pop() ?? ref;
  return last.replace(/\.(schema\.json|json)$/i, "");
}

function deriveEntityName(schema: JsonSchemaNode): string {
  if (typeof schema.title === "string" && schema.title.trim()) {
    return schema.title.trim();
  }
  if (typeof schema.$id === "string" && schema.$id.trim()) {
    // "https://example.com/schemas/user.json" → "user"
    const last = schema.$id.split(/[/#]/).filter(Boolean).pop() ?? "";
    const stripped = last.replace(/\.(json|schema\.json)$/i, "");
    if (stripped) return stripped;
  }
  return IMPORTED_ENTITY_FALLBACK_NAME;
}


// ---------------------------------------------------------------------------
// Document structure: definitions + per-object field mapping
// ---------------------------------------------------------------------------

function isObjectSchema(node: JsonSchemaNode): boolean {
  const { base } = normalizeType(node.type);
  if (base === "object") return true;
  if (base !== undefined) return false;
  if (!!node.properties && typeof node.properties === "object") return true;
  // No `type`, but an `allOf` member contributes properties: an entity assembled from members.
  return collectObjectMembers(node).properties.size > 0;
}

interface ObjectMembers {
  /** Property name → schema, merged across the node and every `allOf` member (first definition wins). */
  properties: Map<string, unknown>;
  required: Set<string>;
  /** `$ref` members of the `allOf` (deduplicated, document order): the base(s) this object extends. */
  baseRefs: string[];
  warnings: string[];
}

/**
 * The object shape of `node` once its `allOf` members are merged (spec Addendum A, rules 1, 4, 5): `properties` and
 * `required` unioned over the node and every inline member, `$ref` members surfaced as bases. A property defined by
 * two members with different schemas keeps the first and warns. Never throws on malformed members.
 */
function collectObjectMembers(node: JsonSchemaNode): ObjectMembers {
  const result: ObjectMembers = { properties: new Map(), required: new Set(), baseRefs: [], warnings: [] };
  const sources = schemaSources(node);
  for (const source of sources) {
    if (source !== node && typeof source.$ref === "string" && !result.baseRefs.includes(source.$ref)) {
      result.baseRefs.push(source.$ref);
    }
    if (isSchemaObject(source.properties)) {
      for (const [name, schema] of Object.entries(source.properties)) {
        if (!result.properties.has(name)) {
          result.properties.set(name, schema);
        } else if (JSON.stringify(result.properties.get(name)) !== JSON.stringify(schema)) {
          result.warnings.push(
            `Property \`${name}\` is defined by more than one allOf member with different schemas; the first definition is kept.`
          );
        }
      }
    }
    if (Array.isArray(source.required)) {
      for (const name of source.required) if (typeof name === "string") result.required.add(name);
    }
  }
  return result;
}

/** The entity a base `$ref` names: in this document → its asset name; otherwise the name derived from the ref. */
function resolveBase(ref: string, ctx: ResolveContext): { name: string; defined: boolean } | undefined {
  if (ref === "#" || ref === "") return ctx.rootEntityName ? { name: ctx.rootEntityName, defined: true } : undefined;
  const def = definitionFor(ctx.definitions, ref);
  if (def) return def.kind === "entity" ? { name: def.assetName, defined: true } : undefined;
  const name = refToEntityName(ref);
  return name ? { name, defined: false } : undefined;
}

/**
 * Break inheritance cycles in the finished entity list. Each entity has at most one `extends`, so every component
 * holds at most one cycle; the entity that closes it in document order loses its `extends` (fields untouched).
 * Iterative and linear: no recursion on document-controlled depth.
 */
export function breakInheritanceCycles(entities: ParsedEntity[], warnings: string[]): void {
  const byName = new Map(entities.map((e, i) => [e.name, { entity: e, index: i }]));
  const done = new Set<string>();
  for (const start of entities) {
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let current: string | undefined = start.name;
    while (current !== undefined && !done.has(current) && !onPath.has(current)) {
      onPath.set(current, path.length);
      path.push(current);
      const next: string | undefined = byName.get(current)?.entity.extends;
      current = next !== undefined && byName.has(next) ? next : undefined;
    }
    if (current !== undefined && onPath.has(current)) {
      const cycle = path.slice(onPath.get(current));
      const closing = cycle.reduce((a, b) => (byName.get(b)!.index > byName.get(a)!.index ? b : a));
      const at = cycle.indexOf(closing);
      const ordered = [...cycle.slice(at + 1), ...cycle.slice(0, at + 1)];
      warnings.push(
        `Inheritance cycle ${[...ordered, ordered[0]].join(" -> ")}: \`extends\` removed from \`${closing}\`.`
      );
      delete byName.get(closing)!.entity.extends;
    }
    for (const name of path) done.add(name);
  }
}

/** `extends` + warnings for an entity whose `allOf` lists base `$ref`s (spec Addendum A, rules 4-5). */
function resolveExtends(
  entityName: string,
  members: ObjectMembers,
  ctx: ResolveContext,
  warnings: string[]
): string | undefined {
  warnings.push(...members.warnings.map((w) => `Entity "${entityName}": ${w}`));
  const bases = members.baseRefs
    .map((ref) => ({ ref, base: resolveBase(ref, ctx) }))
    .filter((b): b is { ref: string; base: { name: string; defined: boolean } } => {
      if (!b.base) warnings.push(`Entity "${entityName}": allOf member \`${b.ref}\` is not an object entity and is ignored as a base.`);
      return b.base !== undefined;
    });
  const [first, ...rest] = bases;
  for (const extra of rest) {
    warnings.push(
      `Entity "${entityName}": allOf lists more than one base; only the first is used as \`extends\`; \`${extra.base.name}\` is not merged.`
    );
  }
  if (first && first.base.name === entityName) {
    warnings.push(`Entity "${entityName}": allOf references the entity itself as its base; \`extends\` is ignored.`);
    return undefined;
  }
  if (!first) return undefined;
  if (!first.base.defined) {
    warnings.push(`Entity "${entityName}": base entity \`${first.base.name}\` is referenced but not defined in this document.`);
  }
  return first.base.name;
}

/** Index root-level `$defs` and `definitions` by the local pointer `$ref` uses. */
function indexDefinitions(
  schema: JsonSchemaNode,
  rootEntityName: string | undefined
): { definitions: Map<string, DefinitionEntry>; taken: Set<string> } {
  const definitions = new Map<string, DefinitionEntry>();
  const taken = new Set(rootEntityName ? [sanitizeIdentifier(rootEntityName)] : []);
  const unionCandidates: DefinitionEntry[] = [];

  for (const keyword of ["$defs", "definitions"] as const) {
    const defs = schema[keyword];
    if (!defs || typeof defs !== "object" || Array.isArray(defs)) continue;

    for (const [key, raw] of Object.entries(defs as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as JsonSchemaNode;
      // A shared enum holds string symbols only; a numeric / mixed / empty `enum` is inlined into the fields that
      // use it (resolveLiteralValues) instead of becoming a shared enum with stringified or missing values.
      const kind: DefinitionEntry["kind"] = isObjectSchema(node)
        ? "entity"
        : Array.isArray(node.enum) && typeof node.$ref !== "string" && isStringEnum(node.enum)
          ? "enum"
          : "inline";

      let assetName = key;
      if (kind !== "inline") {
        assetName = uniqueName(key, taken);
      }
      const entry: DefinitionEntry = { key, node, kind, assetName };
      definitions.set(`#/${keyword}/${key}`, entry);
      if (kind === "inline" && !node.$ref && !node.const && !node.enum && !node.allOf) unionCandidates.push(entry);
    }
  }

  // A `$defs` entry that is a oneOf / anyOf of named refs is a shared union. Decided after every entity / enum is
  // indexed (a member must point at one, or outside the document); unions never nest, so no cycle is possible.
  const probe: ResolveContext = {
    definitions,
    rootEntityName,
    depth: 0,
    nesting: 0,
    taken,
    unions: [],
    warnings: [],
    unionByNode: new WeakMap(),
    sharedUnionMembers: new Map(),
  };
  for (const entry of unionCandidates) {
    const raw = entry.node.oneOf ?? entry.node.anyOf;
    if (!Array.isArray(raw) || !namedRefMembers(raw, probe)) continue;
    entry.kind = "union";
    entry.assetName = uniqueName(sanitizeIdentifier(entry.key), taken);
  }
  return { definitions, taken };
}

function entityExtensions(node: JsonSchemaNode): { extensions?: Record<string, unknown>; ignoredKeywords?: string[] } {
  const sources = schemaSources(node);
  const extensions = captureExtensions(node);
  const found = ignoredKeywordsOf(sources, false) ?? [];
  // An entity-level oneOf / anyOf (alternative `required` sets, a choice between shapes) maps to nothing in the IR: on a FIELD it becomes a
  // union, on an entity it is a constraint over the whole object. Report it like the other unsupported keywords and keep it verbatim.
  let preserved = extensions;
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const holder = sources.find((s) => s[keyword] !== undefined);
    if (!holder) continue;
    if (!found.includes(keyword)) found.push(keyword);
    if (!preserved || !Object.prototype.hasOwnProperty.call(preserved, keyword)) setOwn((preserved ??= {}), keyword, holder[keyword]);
  }
  return { ...(preserved ? { extensions: preserved } : {}), ...(found.length > 0 ? { ignoredKeywords: found } : {}) };
}

const MAX_IGNORED_WARNINGS = 200;

/** Fields whose hoisted keyword appears in several nested members with different values (reported under the same cap). */
const NESTED_CONFLICTS = new WeakMap<object, string[]>();

/** One warning per distinct (keyword, entity/field) pair, capped; the overflow is counted in a final warning. */
function ignoredKeywordWarnings(entities: ParsedEntity[]): string[] {
  const out: string[] = [];
  let total = 0;
  const add = (subject: string, keywords: string[] | undefined): void => {
    for (const keyword of keywords ?? []) {
      if (keyword === "title") continue; // a per-field title is noise against the warning cap; still listed + preserved
      total += 1;
      if (out.length < MAX_IGNORED_WARNINGS) {
        out.push(`${subject}: JSON Schema keyword \`${keyword}\` is not supported and was ignored`);
      }
    }
  };
  for (const entity of entities) {
    add(`Entity \`${entity.name}\``, entity.ignoredKeywords);
    for (const field of entity.fields) {
      add(`Field \`${entity.name}.${field.name}\``, field.ignoredKeywords);
      for (const keyword of NESTED_CONFLICTS.get(field) ?? []) {
        total += 1;
        if (out.length < MAX_IGNORED_WARNINGS) {
          out.push(`Field \`${entity.name}.${field.name}\`: keyword \`${keyword}\` appears in several members with different values; kept the first`);
        }
      }
    }
  }
  if (total > out.length) out.push(`…and ${total - out.length} more ignored-keyword warnings`);
  return out;
}

/** Keys with their own round-trip; the configured classification key can never claim one of them (reserved keys win). */
const RESERVED_EXTENSION_KEYS = new Set(["x-tags", "x-classification"]);

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Field classification from the vendor block (`x-securityClassification: {data_class, data_category}` by default;
 * key and member names are configurable). Read from the merged extension view (property node first, then allOf
 * members), so the property's own block wins. Malformed blocks yield nothing. The block itself stays in `extensions`.
 * Falls back to a plain string `x-classification` (the app's own export) on the first source that has one.
 */
function readClassification(
  sources: JsonSchemaNode[],
  extensions: Record<string, unknown> | undefined,
  config: ClassificationConfig,
): Pick<ParsedField, "classification" | "governance"> {
  const block = RESERVED_EXTENSION_KEYS.has(config.extensionKey) || !extensions
    ? undefined
    : Object.prototype.hasOwnProperty.call(extensions, config.extensionKey)
      ? extensions[config.extensionKey]
      : undefined;
  if (block && typeof block === "object" && !Array.isArray(block)) {
    const own = (name: string) => (Object.prototype.hasOwnProperty.call(block, name) ? (block as Record<string, unknown>)[name] : undefined);
    const dataClass = nonEmptyString(own(config.levelField));
    if (dataClass) {
      const mapped = Object.prototype.hasOwnProperty.call(config.valueMap, dataClass) ? config.valueMap[dataClass] : dataClass;
      const dataCategory = nonEmptyString(own(config.categoryField));
      return { classification: mapped, governance: { dataClass, ...(dataCategory ? { dataCategory } : {}) } };
    }
  }
  for (const source of sources) {
    const level = Object.prototype.hasOwnProperty.call(source, "x-classification")
      ? nonEmptyString(source["x-classification"])
      : undefined;
    if (level) return { classification: level };
  }
  return {};
}

/** Keys of a referenced definition that name the DEFINITION, not the field that points at it. */
const DEFINITION_ONLY_KEYS = new Set(["title", "$schema", "$id", "$defs", "definitions", "$ref"]);

/**
 * The inline (non-entity, non-enum) `$defs` entries the given sources `$ref`, followed through chains, as extra annotation sources:
 * a `$ref: "#/$defs/ShortText"` field keeps the definition's constraints, description, deprecated flag and extensions. They come AFTER
 * the field's own sources, so the property's own siblings win on conflict. A cycle or a chain past MAX_REF_DEPTH stops quietly.
 */
function inlineDefinitionSources(own: JsonSchemaNode[], ctx: ResolveContext): JsonSchemaNode[] {
  const out: JsonSchemaNode[] = [];
  const seen = new Set<JsonSchemaNode>();
  const visit = (source: JsonSchemaNode, depth: number): void => {
    if (typeof source.$ref !== "string" || depth >= MAX_REF_DEPTH) return;
    const def = definitionFor(ctx.definitions, source.$ref);
    if (def?.kind !== "inline" || seen.has(def.node)) return;
    seen.add(def.node);
    for (const member of schemaSources(def.node)) {
      const view: JsonSchemaNode = {};
      for (const [key, value] of Object.entries(member)) if (!DEFINITION_ONLY_KEYS.has(key)) setOwn(view, key, value);
      out.push(view);
      visit(member, depth + 1);
    }
  };
  for (const source of own) visit(source, 0);
  return out;
}

function buildFields(members: ObjectMembers, baseCtx: ResolveContext, ownerName: string): ParsedField[] {
  const requiredSet = members.required;
  const classificationConfig = getClassificationConfig();

  return [...members.properties].map(([name, propNode]) => {
    const node = (propNode && typeof propNode === "object" ? propNode : {}) as JsonSchemaNode;
    const ctx: ResolveContext = { ...baseCtx, unionStem: `${ownerName}_${name}` };
    const resolved = resolveSchemaType(node, ctx);
    const isRequired = requiredSet.has(name);
    // nullable = optional (not in required) OR explicitly `type: [..., "null"]`.
    const nullable = resolved.nullable || !isRequired;

    // A property written as `allOf` merges its members: constraints union (first wins per kind), annotations fold on.
    const ownSources = schemaSources(node);
    const sources = [...ownSources, ...inlineDefinitionSources(ownSources, ctx)];
    const constraints: ParsedFieldConstraint[] = [];
    let minValueExclusive: number | undefined;
    let maxValueExclusive: number | undefined;
    for (const source of sources) {
      const extracted = extractConstraints(source);
      for (const c of extracted.constraints) {
        if (!constraints.some((existing) => existing.type === c.type)) constraints.push(c);
      }
      minValueExclusive ??= extracted.minValueExclusive;
      maxValueExclusive ??= extracted.maxValueExclusive;
    }
    // A numeric const / enum implies a range; an explicit keyword on the property wins.
    for (const implied of resolved.impliedConstraints ?? []) {
      if (!constraints.some((c) => c.type === implied.type)) constraints.push(implied);
    }

    // A validator the emitted TypeSpec scalar does not accept (maxLength on a date-time) is kept on the field but not written to the
    // generated source (the real compiler rejects it); say so instead of dropping it silently.
    const withheld = [
      ...constraints.map((c) => c.type),
      ...(minValueExclusive !== undefined ? ["minValueExclusive"] : []),
      ...(maxValueExclusive !== undefined ? ["maxValueExclusive"] : []),
    ].filter((kind) => !constraintAppliesTo(resolved.type, kind as ConstraintKind));
    for (const kind of withheld) {
      baseCtx.warnings.push(
        `Field \`${ownerName}.${name}\`: constraint \`${kind}\` was not applied to ${resolved.type} (the TypeSpec type does not accept it); it is kept on the field.`
      );
    }

    const field: ParsedField = {
      name,
      type: resolved.type,
      nullable,
      description: sources.find((s) => typeof s.description === "string")?.description,
      confidence: resolved.confidence,
      originalType: resolved.originalType,
      // Heuristic: a required property literally named "id" is the key.
      isKey: isRequired && name === "id",
      format: resolved.format,
      deprecated: sources.some((s) => s.deprecated === true) || undefined,
      constraints: constraints.length > 0 ? constraints : undefined,
      minValueExclusive,
      maxValueExclusive,
    };

    let extensions: Record<string, unknown> | undefined;
    for (const source of sources) {
      for (const [key, value] of Object.entries(captureExtensions(source, true) ?? {})) {
        if (extensions && Object.prototype.hasOwnProperty.call(extensions, key)) continue;
        setOwn((extensions ??= {}), key, value);
      }
    }
    // Unsupported keywords inside an array `items` schema or a oneOf / anyOf member are not mapped either: they are
    // listed (and preserved, first definition wins) on the field that owns them.
    // NOTE: nested hoisting is deliberate: keywords found in `items` / a oneOf member are lifted onto this field, and
    // when several members define the same keyword the first definition wins (a differing later value is reported).
    const nested = nestedSchemas(sources);
    const hoisted = new Set<string>();
    for (const source of nested) {
      for (const key of Object.keys(source)) {
        if (!IGNORED_SCHEMA_KEYWORDS.has(key)) continue;
        if (extensions && Object.prototype.hasOwnProperty.call(extensions, key)) {
          if (hoisted.has(key) && JSON.stringify(extensions[key]) !== JSON.stringify(source[key])) {
            const list = NESTED_CONFLICTS.get(field) ?? [];
            if (!list.includes(key)) list.push(key);
            NESTED_CONFLICTS.set(field, list);
          }
          continue;
        }
        hoisted.add(key);
        setOwn((extensions ??= {}), key, source[key]);
      }
    }
    if (extensions) field.extensions = extensions;
    const ignoredKeywords = ignoredKeywordsOf([...sources], true, nested);
    if (ignoredKeywords) field.ignoredKeywords = ignoredKeywords;

    const classified = readClassification(sources, extensions, classificationConfig);
    if (classified.classification) field.classification = classified.classification;
    if (classified.governance) field.governance = classified.governance;

    if (resolved.referencedEntityName) field.referencedEntityName = resolved.referencedEntityName;
    if (resolved.enumName) field.enumName = resolved.enumName;
    if (resolved.enumValues) field.enumValues = resolved.enumValues;
    if (resolved.unionName) field.unionName = resolved.unionName;
    if (resolved.unionMembers) field.unionMembers = resolved.unionMembers;
    if (resolved.lowFromUnresolvedRef) LOW_FROM_UNRESOLVED_REF.add(field);
    if (resolved.type === "reference" && resolved.lowFromUnresolvedRef && isExternalRef(resolved.originalType)) {
      field.danglingRef = { ref: resolved.originalType, reason: DANGLING_REASON };
    }

    // Array element type (+ reference / enum target of the element).
    const items = sources.find((s) => s.items)?.items;
    if (resolved.type === "array" && items && !Array.isArray(items)) {
      const item = resolveSchemaType(items as JsonSchemaNode, ctx);
      field.arrayElementType = item.type;
      if (item.referencedEntityName) field.referencedEntityName = item.referencedEntityName;
      if (item.enumName) field.enumName = item.enumName;
      if (item.enumValues) field.enumValues = item.enumValues;
      if (item.unionName) field.unionName = item.unionName;
      if (item.unionMembers) field.unionMembers = item.unionMembers;
      if (item.type === "reference" || item.type === "enum" || item.type === "union") field.confidence = item.confidence;
      if (item.type === "reference") ARRAY_ITEM_REF.set(field, item.originalType);
      if (item.lowFromUnresolvedRef) LOW_FROM_UNRESOLVED_REF.add(field);
      else LOW_FROM_UNRESOLVED_REF.delete(field);
      if (item.type === "reference" && item.lowFromUnresolvedRef && isExternalRef(item.originalType)) {
        field.danglingRef = { ref: item.originalType, reason: DANGLING_REASON, element: true };
      }
    }

    return field;
  });
}

/** JSON first; anything that is not JSON-shaped is tried as YAML (JSON Schema is often authored in YAML). */
function parseStructured(content: string): JsonSchemaNode | null {
  try {
    return JSON.parse(content);
  } catch {
    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
    try {
      return parseYaml(trimmed) as JsonSchemaNode;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A leading UTF-8 byte-order mark (Windows editors, some exporters) is not part of the document. */
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Never throws (the `Result` contract): a document nested past the engine's stack, or any other failure while
 * mapping it, comes back as a `PARSE_ERROR` instead of an unhandled exception in the import action.
 */
export function parseJsonSchemaDocument(rawContent: string): Result<MultiEntityImportResult> {
  return parseGuarded(rawContent);
}

/** A named `$defs` / `definitions` entry of a parsed document, as the importer classified and named it. */
export interface DefinitionIndexEntry {
  kind: "entity" | "enum" | "union" | "inline";
  assetName: string;
}

/**
 * `parseJsonSchemaDocument` plus the local-pointer index of the document's definitions (`#/$defs/Foo` -> kind and
 * final asset name), so a cross-file `$ref` with a fragment can be pointed at the right asset.
 */
export function parseJsonSchemaDocumentIndexed(
  rawContent: string
): Result<{ doc: MultiEntityImportResult; definitions: Map<string, DefinitionIndexEntry> }> {
  const definitions = new Map<string, DefinitionIndexEntry>();
  const parsed = parseGuarded(rawContent, definitions);
  if (!parsed.success) return parsed;
  return ok({ doc: parsed.data, definitions });
}

function parseGuarded(rawContent: string, outIndex?: Map<string, DefinitionIndexEntry>): Result<MultiEntityImportResult> {
  try {
    return importJsonSchemaDocument(stripBom(rawContent), outIndex);
  } catch (error) {
    return err({
      code: "PARSE_ERROR",
      message:
        error instanceof RangeError
          ? "JSON Schema is nested too deeply to import"
          : "Could not import the JSON Schema document",
      suggestedFix: "Simplify the schema (flatten deeply nested combinators) or split it into $defs.",
    });
  }
}

function importJsonSchemaDocument(content: string, outIndex?: Map<string, DefinitionIndexEntry>): Result<MultiEntityImportResult> {
  const schema = parseStructured(content);
  if (schema === null) {
    return err({
      code: "PARSE_ERROR",
      message: "Invalid JSON: could not parse JSON Schema",
      suggestedFix: "Ensure the content is a valid JSON Schema document (JSON or YAML).",
    });
  }

  if (typeof schema !== "object" || Array.isArray(schema)) {
    return err({
      code: "PARSE_ERROR",
      message: "Expected a JSON Schema object at the top level",
      suggestedFix: 'The root must be an object with a "properties" map (an object schema).',
    });
  }

  const { base: rootBase } = normalizeType(schema.type);

  if (rootBase === "array") {
    return err({
      code: "PARSE_ERROR",
      message: "Array-root JSON Schemas are not supported for entity import",
      suggestedFix: "Wrap the item schema in an object, or import the element schema directly.",
    });
  }

  // A root assembled from `allOf` members is an entity too (properties from members, or a typed object with a base).
  const rootMembers = collectObjectMembers(schema);
  const rootIsEntity = rootMembers.properties.size > 0 || (rootBase === "object" && rootMembers.baseRefs.length > 0);
  const rootEntityName = rootIsEntity ? deriveEntityName(schema) : undefined;
  const { definitions, taken } = indexDefinitions(schema, rootEntityName);
  const warnings: string[] = [];
  const unions: ParsedUnion[] = [];
  const ctx: ResolveContext = {
    definitions,
    rootEntityName,
    depth: 0,
    nesting: 0,
    taken,
    unions,
    warnings,
    unionByNode: new WeakMap(),
    sharedUnionMembers: new Map(),
  };
  // Shared unions first: a field `$ref`-ing one carries its members (see resolveRef).
  for (const def of definitions.values()) {
    if (def.kind !== "union") continue;
    const found = namedRefMembers((def.node.oneOf ?? def.node.anyOf) as unknown[], ctx);
    if (found) ctx.sharedUnionMembers.set(def.assetName, boundMembers(found.names, def.assetName, warnings));
    const unresolved = unresolvedMemberRefs((def.node.oneOf ?? def.node.anyOf) as unknown[], ctx);
    if (found && unresolved.length > 0) {
      (ctx.unresolvedSharedUnions ??= new Set()).add(def.assetName);
      warnings.push(unresolvedUnionWarning(def.assetName, unresolved));
    }
  }

  const entities: ParsedEntity[] = [];
  if (rootIsEntity && rootEntityName) {
    const rootExtends = resolveExtends(rootEntityName, rootMembers, ctx, warnings);
    entities.push({
      name: rootEntityName,
      description: typeof schema.description === "string" ? schema.description : undefined,
      fields: buildFields(rootMembers, ctx, rootEntityName),
      ...(rootExtends ? { extends: rootExtends } : {}),
      ...entityExtensions(schema),
      sourceFormat: "json-schema",
      originalContent: content,
    });
  }

  const enums: ParsedEnum[] = [];
  const sharedUnions: ParsedUnion[] = [];
  for (const def of definitions.values()) {
    if (def.kind === "entity") {
      const members = collectObjectMembers(def.node);
      const defExtends = resolveExtends(def.assetName, members, ctx, warnings);
      entities.push({
        name: def.assetName,
        description: typeof def.node.description === "string" ? def.node.description : undefined,
        fields: buildFields(members, ctx, def.assetName),
        ...(defExtends ? { extends: defExtends } : {}),
        ...entityExtensions(def.node),
        sourceFormat: "json-schema",
        originalContent: content,
      });
    } else if (def.kind === "enum") {
      const parsedEnum: ParsedEnum = {
        name: def.assetName,
        // `kind: "enum"` is only assigned to all-string enums (indexDefinitions).
        values: [...new Set((def.node.enum ?? []).filter((v) => v !== null) as string[])],
      };
      if (typeof def.node.description === "string") parsedEnum.description = def.node.description;
      enums.push(parsedEnum);
    } else if (def.kind === "union") {
      const memberTypes = ctx.sharedUnionMembers.get(def.assetName);
      if (memberTypes) {
        const shared: ParsedUnion = { name: def.assetName, memberTypes };
        if (typeof def.node.description === "string") shared.description = def.node.description;
        sharedUnions.push(shared);
      }
    }
  }

  breakInheritanceCycles(entities, warnings);
  warnings.push(...ignoredKeywordWarnings(entities));

  if (outIndex) {
    for (const [pointer, def] of definitions) outIndex.set(pointer, { kind: def.kind, assetName: def.assetName });
  }

  if (entities.length === 0) {
    return err({
      code: "PARSE_ERROR",
      message: "JSON Schema has no properties to import",
      suggestedFix: 'Provide an object schema with a non-empty "properties" map (at the root or in "$defs").',
    });
  }

  for (const def of definitions.values()) {
    if (def.kind !== "inline" && def.assetName !== def.key) {
      warnings.push(`Definition "${def.key}" clashes with the root entity name — imported as "${def.assetName}".`);
    }
  }

  // An entity or field name longer than the limit is refused: the emitters write a file per declaration and crash (ENAMETOOLONG) on a
  // very long one. An over-long entity name skips that entity; an over-long field name drops that field (an entity left with no field is
  // skipped). Skipping the ROOT entity is an error (the document would silently import as a different entity); skipping another entity
  // is a warning, and every field that pointed at it becomes a visible dangling reference.
  const limit = MAX_IMPORTED_NAME_LENGTH;
  const clip = (name: string): string => (name.length > 40 ? `${name.slice(0, 40)}...` : name);
  const skipped = new Map<string, string>();
  const notes: string[] = [];
  const kept: ParsedEntity[] = [];
  for (const entity of entities) {
    if (entity.name.length > limit) {
      skipped.set(entity.name, `Entity "${clip(entity.name)}" has a name of ${entity.name.length} characters (the limit is ${limit})`);
      continue;
    }
    const long = entity.fields.filter((f) => f.name.length > limit);
    if (long.length === 0) { kept.push(entity); continue; }
    const rest = entity.fields.filter((f) => f.name.length <= limit);
    for (const f of long) notes.push(`Entity "${entity.name}" has the field "${clip(f.name)}" with a name of ${f.name.length} characters (the limit is ${limit}); the field was dropped.`);
    if (rest.length === 0) {
      skipped.set(entity.name, `Entity "${entity.name}" has the field "${clip(long[0].name)}" with a name longer than ${limit} characters and no other field`);
      continue;
    }
    kept.push({ ...entity, fields: rest });
  }
  const refuse = (message: string) => err({ code: "PARSE_ERROR" as const, message: `${message}; names longer than ${limit} characters cannot be imported.`, suggestedFix: "Shorten the title / property names." });
  if (rootEntityName !== undefined && skipped.has(rootEntityName)) return refuse(skipped.get(rootEntityName)!);
  if (kept.length === 0 && skipped.size > 0) return refuse([...skipped.values()][0]);
  for (const reason of skipped.values()) warnings.push(`${reason}; it was skipped (names longer than ${limit} characters cannot be imported).`);
  warnings.push(...notes);
  if (skipped.size > 0) {
    for (const entity of kept) {
      if (entity.extends && skipped.has(entity.extends)) {
        warnings.push(`Entity "${entity.name}" extended "${clip(entity.extends)}", which was skipped (name too long); it no longer extends anything.`);
        entity.extends = undefined;
      }
      for (const field of entity.fields) {
        const names = [field.referencedEntityName, ...(field.unionMembers ?? [])].filter((n): n is string => n !== undefined && skipped.has(n));
        if (names.length === 0) continue;
        warnings.push(`Field "${field.name}" of "${entity.name}" refers to "${clip(names[0])}", which was skipped (name too long); it is kept as an unresolved reference.`);
        if (field.type === "reference" || (field.type === "array" && field.arrayElementType === "reference")) {
          field.confidence = "low";
          field.danglingRef = { ref: (field.type === "array" ? ARRAY_ITEM_REF.get(field) : undefined) ?? field.originalType, reason: `refers to "${clip(names[0])}", which was skipped because its name is longer than ${limit} characters`, ...(field.type === "array" ? { element: true as const } : {}) };
        }
      }
    }
  }
  entities.splice(0, entities.length, ...kept);
  for (const entity of entities) {
    for (const collision of collidingFieldNames(entity.fields.map((f) => f.name))) {
      warnings.push(`Entity "${entity.name}": the fields ${collision.names.map((n) => `"${n}"`).join(" and ")} would both be written as "${collision.becomes}" in ${collision.targets.join(", ")}; those targets will refuse to generate until one is renamed.`);
    }
  }

  const tooMany = importCountLimitMessage(entities.length, enums.length);
  if (tooMany) return err({ code: "PARSE_ERROR", message: tooMany, suggestedFix: "Split the schema into smaller documents." });
  budgetOriginalContent(entities, warnings);

  return ok({
    sourceFormat: "json-schema",
    entities,
    ...(rootIsEntity && rootEntityName ? { rootEntityName } : {}),
    enums,
    scalars: [],
    unions: [...sharedUnions, ...unions],
    warnings,
  });
}

export function parseJsonSchema(content: string): Result<ParsedEntity> {
  const doc = parseJsonSchemaDocument(content);
  if (!doc.success) return doc;
  return ok(pickRootEntity(doc.data));
}
