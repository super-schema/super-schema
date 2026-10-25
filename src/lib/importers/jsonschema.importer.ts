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

import { parseYamlBounded } from "./safe-yaml";
import { importResponseTooLargeMessage } from "./response-size";
import { collidingFieldNames } from "@/lib/typespec-official/name-collisions";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import { MAX_LITERAL_DEPTH, setOwn } from "@/lib/compiler/governance-decorators";
import { getClassificationConfig, type ClassificationConfig } from "./classification-config";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { constraintAppliesTo, type ConstraintKind } from "@/lib/compiler/constraint-targets";
import { pickRootEntity } from "./multi-asset";
import { getTypeInfo } from "@/lib/data-types";
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

/** The schemas directly below `node` that the importer reads for a TYPE: `items` and the `oneOf` / `anyOf` members, labelled by where they sit. */
function childSchemas(node: JsonSchemaNode): { label: string; node: JsonSchemaNode }[] {
  const out: { label: string; node: JsonSchemaNode }[] = [];
  if (isSchemaObject(node.items)) out.push({ label: "items", node: node.items as JsonSchemaNode });
  else if (Array.isArray(node.items)) {
    node.items.forEach((member, i) => {
      if (isSchemaObject(member)) out.push({ label: `items[${i}]`, node: member });
    });
  }
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const list = node[keyword];
    if (!Array.isArray(list)) continue;
    list.forEach((member, i) => {
      if (isSchemaObject(member)) out.push({ label: `${keyword}[${i}]`, node: member });
    });
  }
  return out;
}

/** Nesting below a field that is scanned for keywords (items of items of ...); deeper than this is not a real schema and is reported. */
const MAX_NESTED_DEPTH = 16;

/** A schema below a field (an `items` schema, a combinator member, ...) with the place it sits at (`items`, `oneOf[1]`, `items.items`). */
interface NestedNode {
  site: string;
  node: JsonSchemaNode;
}

/**
 * The members of a `oneOf` / `anyOf` that is only a nullable wrapper (`[X, { type: "null" }]`, or a single `X`), followed through: such a
 * member IS the field (its constraints, description and extensions are the field's), where a member of a real choice is only one alternative.
 */
function nullableWrapperMembers(sources: JsonSchemaNode[]): JsonSchemaNode[] {
  const out: JsonSchemaNode[] = [];
  const seen = new Set<JsonSchemaNode>(sources);
  const visit = (node: JsonSchemaNode, depth: number): void => {
    if (depth >= MAX_NESTED_DEPTH) return;
    for (const keyword of ["oneOf", "anyOf"] as const) {
      const list = node[keyword];
      if (!Array.isArray(list)) continue;
      const real = list.filter((m) => !isNullMember(m));
      if (real.length !== 1 || !isSchemaObject(real[0]) || seen.has(real[0])) continue;
      seen.add(real[0]);
      out.push(real[0]);
      visit(real[0], depth + 1);
    }
  };
  for (const source of sources) visit(source, 0);
  return out;
}

/**
 * Every schema below the field's own sources, breadth first: `items` and `oneOf` / `anyOf` members, at any depth, each with its `allOf`
 * members and the inline definitions it `$ref`s (they all describe the same element). The importer maps the TYPE of these and nothing else, so
 * what they carry has no node of its own in the IR and is folded onto the field (see `foldNestedNode`). `wrappers` are the nullable-wrapper
 * members (the field itself): not reported, but looked through. Bounded: every node is charged against the import's visit budget, a node is
 * visited once, and past MAX_NESTED_DEPTH the place is returned in `tooDeep` instead of being scanned.
 */
function nestedSchemaNodes(
  roots: JsonSchemaNode[],
  wrappers: ReadonlySet<JsonSchemaNode>,
  ctx: ResolveContext
): { nodes: NestedNode[]; tooDeep: string[] } {
  const nodes: NestedNode[] = [];
  const tooDeep: string[] = [];
  const seen = new Set<JsonSchemaNode>(roots);
  let frontier = roots.map((node) => ({ node, site: "", depth: 0 }));
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { node, site, depth } of frontier) {
      for (const child of childSchemas(node)) {
        if (seen.has(child.node)) continue;
        seen.add(child.node);
        const isWrapper = wrappers.has(child.node);
        const childSite = isWrapper ? site : site === "" ? child.label : `${site}.${child.label}`;
        if (!isWrapper && depth + 1 > MAX_NESTED_DEPTH) {
          tooDeep.push(childSite);
          continue;
        }
        const members = [child.node, ...flattenAllOf(child.node).members];
        const views = [...members, ...inlineDefinitionSources(members, ctx)];
        for (const view of views) {
          charge(ctx.run);
          if (!isWrapper) nodes.push({ site: childSite, node: view });
          next.push({ node: view, site: childSite, depth: isWrapper ? depth : depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return { nodes, tooDeep };
}

/** `oneOf[1].items` -> `oneOf-1-items`: a site as part of an extension key. */
function siteKey(site: string): string {
  return site.replace(/\[(\d+)\]/g, "-$1").replace(/\./g, "-");
}

/** Whether `value` nests deeper than `max` levels (iterative; a scalar is level 1): a value the extension writer would have to leave out. */
function nestsDeeperThan(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (depth > max) return true;
    if (typeof current !== "object" || current === null) continue;
    for (const child of Array.isArray(current) ? current : Object.values(current)) stack.push([child, depth + 1]);
  }
  return false;
}

/** Keys read by the type resolution of a nested schema: nothing to fold. */
const NESTED_CONSUMED_KEYS = new Set(["$ref", "type", "items", "oneOf", "anyOf", "allOf", "enum", "const"]);

/**
 * Keys of a nested schema that describe the ELEMENT and have no slot on the field: the constraints, description and deprecated flag of an
 * `items` / member schema (the IR has no element-constraint concept) and the keys that only name a schema. Kept as `x-<site>-<keyword>`:
 * never under their own name, where they would replace the field's own value of the keyword when the extensions are re-emitted.
 */
const ELEMENT_KEYS = new Set([
  "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems",
  "description", "deprecated", "title", "$schema", "$id", "$defs", "definitions", "properties", "required",
]);

/** Whether the resolved type of a field took the `format` (kept as its format hint, or turned into its logical type): nothing else carries it. */
function formatTaken(format: string, resolved: ResolvedType): boolean {
  if (resolved.format === format) return true;
  if (resolved.originalType.startsWith("type(")) return true; // a scalar union: the format named its members
  // The format became the logical type (date-time -> utcDateTime, int64 -> int64): the field has it, whatever wrapper it came through.
  return [STRING_FORMAT_MAP, INTEGER_FORMAT_MAP, NUMBER_FORMAT_MAP].some((map) => {
    const mapped = map[format];
    return mapped !== undefined && !("keepFormat" in mapped && mapped.keepFormat) && mapped.type === resolved.type;
  });
}

/** Whether the importer turns a `format` into a logical type of its own (a format it only passes through is not kept for an element). */
function formatIsInterpreted(format: unknown): boolean {
  if (typeof format !== "string") return false;
  const mapped = STRING_FORMAT_MAP[format] ?? INTEGER_FORMAT_MAP[format] ?? NUMBER_FORMAT_MAP[format];
  return mapped !== undefined && !("keepFormat" in mapped && mapped.keepFormat);
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

/**
 * What one import has spent resolving types, shared by every copy of the `ResolveContext` of that import.
 * `visits` bounds the TOTAL work (a hostile `allOf` fan-out is exponential in its depth: depth bounds the chain, not the breadth);
 * `inline` remembers what each inline `$defs` entry resolved to, so a definition reached along many paths (a diamond) is resolved once.
 */
interface ResolveRun {
  budget: ResolveBudget;
  /** Definition node -> (ref depth, combinator nesting) -> its resolution. Both numbers are part of the key: they decide where resolution stops. */
  inline: Map<JsonSchemaNode, Map<number, ResolvedType>>;
}

/** The work an import may spend resolving types: `resolveSchemaType` calls and inline-definition views. Shared across the documents of a URL import. */
export interface ResolveBudget {
  visits: number;
  limit: number;
}

/** One document may make this many visits; a legitimate 2000-property schema makes about 10,000. Past it the import is refused, never slow. */
export const MAX_RESOLVE_VISITS = 500_000;
/** All the documents of one URL import together (each is resolved on the event loop, so the total is what blocks it). */
export const MAX_RESOLVE_VISITS_PER_URL_IMPORT = 1_500_000;

let resolveVisitLimitOverride: number | undefined;
/** Test seam: replaces (or, with `undefined`, restores) the visit limits so the refusal can be provoked with a small document. */
export function setResolveVisitLimitForTests(limit: number | undefined): void {
  resolveVisitLimitOverride = limit;
}

/** A fresh budget: for one document, or (`forUrlImport`) for every document of one URL import. */
export function createResolveBudget(forUrlImport = false): ResolveBudget {
  return { visits: 0, limit: resolveVisitLimitOverride ?? (forUrlImport ? MAX_RESOLVE_VISITS_PER_URL_IMPORT : MAX_RESOLVE_VISITS) };
}

/** Thrown when an import exhausts its visit budget; `parseGuarded` turns it into the PARSE_ERROR the caller sees. */
class ResolveBudgetError extends Error {}

function newRun(budget: ResolveBudget = createResolveBudget()): ResolveRun {
  return { budget, inline: new Map() };
}

function charge(run: ResolveRun): void {
  if (++run.budget.visits > run.budget.limit) throw new ResolveBudgetError("resolve budget exhausted");
}

interface ResolveContext {
  definitions: Map<string, DefinitionEntry>;
  /** The work spent so far by this import (one object shared by every context copy). */
  run: ResolveRun;
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
  /** `<Entity>.<field>` of the property being resolved, for the warnings of a type that cannot be imported whole. */
  fieldLabel?: string;
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

/**
 * What one import may preserve verbatim on its fields (extensions, `default` / `examples`, descriptions), in serialised bytes. A `$ref` to an
 * inline definition copies the definition's values onto every field that points at it, so a 200 KB value and 100 references came back as 20 MB.
 * Within the budget nothing changes; past it a REPEAT of a large value is not copied again (see `budgetPreservedValues`).
 */
export const MAX_PRESERVED_VALUE_BYTES = 2_000_000;
/** A repeat shorter than this is always kept: it cannot amplify the response more than a small multiple of the references that name it. */
const MIN_BUDGETED_VALUE_BYTES = 128;

/**
 * Keeps the values preserved on the fields of `entities` within `MAX_PRESERVED_VALUE_BYTES` in total. Entities are walked in order and every
 * copy is counted; once the budget is spent, a copy of a value (same key, same serialised value) that an earlier field already carries and that
 * is at least 128 bytes long is dropped instead of repeated, and one warning per key counts the fields it was dropped from. The first copy is
 * always kept, distinct values are always kept (they cannot outgrow the source text), and so are short ones.
 */
export function budgetPreservedValues(entities: ParsedEntity[], warnings: string[], limit: number = MAX_PRESERVED_VALUE_BYTES): void {
  const serialised = new Map<object, string>();
  const text = (value: unknown): string => {
    if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "";
    let s = serialised.get(value);
    if (s === undefined) {
      s = JSON.stringify(value) ?? "";
      serialised.set(value, s);
    }
    return s;
  };

  let total = 0;
  for (const entity of entities) {
    for (const field of entity.fields) {
      total += field.description?.length ?? 0;
      for (const [key, value] of Object.entries(field.extensions ?? {})) total += key.length + text(value).length;
    }
  }
  if (total <= limit) return;

  let used = 0;
  const seen = new Set<string>();
  const dropped = new Map<string, { fields: number; bytes: number }>();
  const note = (key: string, bytes: number): void => {
    const entry = dropped.get(key) ?? { fields: 0, bytes };
    entry.fields += 1;
    dropped.set(key, entry);
  };
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.description !== undefined) {
        const id = `description\u0000${field.description}`;
        const bytes = field.description.length;
        if (used > limit && bytes >= MIN_BUDGETED_VALUE_BYTES && seen.has(id)) {
          field.description = undefined;
          note("description", bytes);
        } else {
          used += bytes;
          seen.add(id);
        }
      }
      if (!field.extensions) continue;
      for (const [key, value] of Object.entries(field.extensions)) {
        const s = text(value);
        const id = `${key}\u0000${s}`;
        if (used > limit && s.length >= MIN_BUDGETED_VALUE_BYTES && seen.has(id)) {
          delete field.extensions[key];
          note(key, s.length);
        } else {
          used += key.length + s.length;
          seen.add(id);
        }
      }
      if (Object.keys(field.extensions).length === 0) delete field.extensions;
    }
  }
  for (const [key, { fields, bytes }] of dropped) {
    const what = key === "description" ? "Description" : `Extension \`${key}\``;
    warnings.push(
      `${what} on ${fields} field${fields === 1 ? "" : "s"} was not repeated: the same value of ${bytes.toLocaleString("en-US")} bytes is kept on the first field that carries it (the schema's preserved values passed ${limit.toLocaleString("en-US")} bytes).`
    );
  }
}

const MAX_REF_DEPTH = 16;
/** Combinator nesting past this is not a real schema; resolve it as an unknown at low confidence. */
export const MAX_SCHEMA_NESTING = 200;

/** Every symbol of an `enum` / `const` is a string (nulls aside) — the only shape the enum IR carries. */
function isStringEnum(values: unknown[]): boolean {
  const symbols = values.filter((v) => v !== null);
  return symbols.length > 0 && symbols.every((v) => typeof v === "string");
}

/** An enum with more symbols than this is not a real enum; the excess is dropped (and reported), as a union's excess members are. */
export const MAX_ENUM_VALUES = 5000;

/** Enums already reported as too large (by their node), so a definition used by many fields is reported once. */
const ENUM_BOUND_WARNED = new WeakSet<object>();

/** The first MAX_ENUM_VALUES symbols, reporting what was dropped (once per `source` list). */
function boundEnumSymbols(symbols: string[], label: string, warnings: string[] | undefined, source: object): string[] {
  if (symbols.length <= MAX_ENUM_VALUES) return symbols;
  if (warnings !== undefined && !ENUM_BOUND_WARNED.has(source)) {
    ENUM_BOUND_WARNED.add(source);
    warnings.push(`Enum ${label} has ${symbols.length} values; only the first ${MAX_ENUM_VALUES} are kept (${symbols.length - MAX_ENUM_VALUES} dropped).`);
  }
  return symbols.slice(0, MAX_ENUM_VALUES);
}

/** `enum(1,2,5)`: the original type of an enum, with its values listed up to 50 of them (a longer list is its length: the label is shown). */
function enumLabel(values: unknown[]): string {
  return values.length > 50 ? `enum(${values.length} values)` : `enum(${values.map((v) => JSON.stringify(v)).join(",")})`;
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
function resolveLiteralValues(values: unknown[], originalType: string, ctx?: ResolveContext): ResolvedType {
  const nullable = values.includes(null);
  const symbols = values.filter((v) => v !== null);

  if (isStringEnum(values)) {
    const unique = boundEnumSymbols([...new Set(symbols as string[])], ctx?.fieldLabel ?? "an enum", ctx?.warnings, values);
    // Symbols travel as "A|B|C" (the generator reads them back from the pattern slot), so one that holds the
    // separator, or is empty, cannot round-trip: flag it rather than silently splitting it.
    const lossy = unique.some((s) => s === "" || s.includes("|"));
    return { type: "enum", confidence: lossy ? "low" : "high", nullable, originalType, enumValues: unique };
  }

  if (symbols.length > 0 && symbols.every((v) => typeof v === "number" && Number.isFinite(v))) {
    // A loop, not Math.min(...numbers): spreading a few hundred thousand values overflows the call stack.
    const numbers = symbols as number[];
    let min = numbers[0];
    let max = numbers[0];
    let integers = true;
    for (const n of numbers) {
      if (n < min) min = n;
      if (n > max) max = n;
      if (integers && !Number.isInteger(n)) integers = false;
    }
    return {
      type: integers ? "integer" : "float64",
      confidence: "low",
      nullable,
      originalType,
      impliedConstraints: [
        { type: "minValue", value: min },
        { type: "maxValue", value: max },
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

/** A copy a caller may keep: the memoised resolution is shared by every path that reaches the definition. */
function cloneResolved(r: ResolvedType): ResolvedType {
  return {
    ...r,
    ...(r.enumValues ? { enumValues: [...r.enumValues] } : {}),
    ...(r.unionMembers ? { unionMembers: [...r.unionMembers] } : {}),
    ...(r.impliedConstraints ? { impliedConstraints: r.impliedConstraints.map((c) => ({ ...c })) } : {}),
  };
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
      enumValues: boundEnumSymbols([...new Set(values)], def.assetName, ctx.warnings, def.node),
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
    // Resolved once per (definition, depth, nesting): along every path that reaches it the same way the answer is the same, and without
    // this a definition whose `allOf` lists the next one several times costs members^depth.
    const slot = ctx.depth * 1024 + ctx.nesting;
    let bySlot = ctx.run.inline.get(def.node);
    const hit = bySlot?.get(slot);
    if (hit) return cloneResolved(hit);
    const resolved = resolveSchemaType(def.node, { ...ctx, depth: ctx.depth + 1 });
    if (!bySlot) {
      bySlot = new Map();
      ctx.run.inline.set(def.node, bySlot);
    }
    bySlot.set(slot, resolved);
    return cloneResolved(resolved);
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

/** The JSON Schema types a scalar union can hold (each is one TypeSpec scalar). */
const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

/** The TypeSpec scalar a scalar `type` (+ its `format`) imports as: `integer` -> `integer`, `number` -> `float64`, `date-time` -> `utcDateTime`. */
function scalarTypeName(type: string, format: unknown, ctx: ResolveContext): string | undefined {
  const logical = resolveSchemaType({ type, ...(typeof format === "string" ? { format } : {}) }, ctx).type;
  return getTypeInfo(logical)?.typespecScalar;
}

/**
 * The TypeSpec scalar a combinator member stands for when the member is only a scalar type (`{ type: "string" }`, with a format and any
 * constraints): `undefined` for anything else (a `$ref`, an enum / const, an object, an array, a nested combinator, several types).
 * `nullable` when the member's own `type` list has `null` in it.
 */
function scalarMember(member: JsonSchemaNode, ctx: ResolveContext): { name: string; nullable: boolean } | undefined {
  if (typeof member.$ref === "string") return undefined;
  for (const key of ["enum", "const", "properties", "items", "oneOf", "anyOf", "allOf"]) if (member[key] !== undefined) return undefined;
  const types = [...new Set((Array.isArray(member.type) ? member.type : [member.type]).filter((t): t is string => typeof t === "string"))];
  const real = types.filter((t) => t !== "null");
  if (real.length !== 1 || !SCALAR_TYPES.has(real[0])) return undefined;
  const name = scalarTypeName(real[0], member.format, ctx);
  return name === undefined ? undefined : { name, nullable: types.includes("null") };
}

/**
 * The member names of a `oneOf` / `anyOf` whose every non-null member is a `$ref` to a named entity / enum
 * (in-document, or external and unresolved), or every one a plain scalar type, deduplicated in order. `undefined` when any member is
 * something else (an inline object, an enum, an array, a boolean schema, a ref to an inline definition, a ref mixed with a scalar) or
 * fewer than two names remain — the caller keeps its first-member fallback then, never a partial union.
 */
function namedRefMembers(raw: unknown[], ctx: ResolveContext): { names: string[]; hasNull: boolean } | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  let hasNull = false;
  let refs = 0;
  let scalars = 0;
  for (const m of raw) {
    if (isNullMember(m)) {
      hasNull = true;
      continue;
    }
    if (!isSchemaObject(m)) return undefined;
    let name: string | undefined;
    if (typeof m.$ref === "string") {
      name = unionMemberName(m.$ref, ctx);
      refs += 1;
    } else {
      const scalar = scalarMember(m, ctx);
      if (scalar?.nullable) hasNull = true;
      name = scalar?.name;
      scalars += 1;
    }
    if (name === undefined) return undefined;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  // Refs only, or scalars only: a ref next to a scalar keeps the first-member fallback (a union that names an entity is not generated
  // for most targets, and a field that used to generate must not stop doing so; see KD-029).
  if (refs > 0 && scalars > 0) return undefined;
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

/** Nodes whose `type` list could not become a union (reported once, however many times the node is resolved). */
const TYPE_LIST_WARNED = new WeakSet<object>();

/** The union generated for `node` (one per node, however many times it is resolved), declared on first use with `names` as its members. */
function declareUnion(node: JsonSchemaNode, names: string[], ctx: ResolveContext, unresolved: string[] = []): { name: string; memberTypes: string[] } {
  let name = ctx.unionByNode.get(node);
  if (name === undefined) {
    name = uniqueName(`${sanitizeIdentifier(ctx.unionStem ?? "Anonymous")}_Union`, ctx.taken);
    ctx.unionByNode.set(node, name);
    ctx.unions.push({ name, memberTypes: boundMembers(names, name, ctx.warnings) });
    if (unresolved.length > 0) ctx.warnings.push(unresolvedUnionWarning(name, unresolved));
  }
  return { name, memberTypes: ctx.unions.find((u) => u.name === name)?.memberTypes ?? names };
}

/** A property-level `oneOf` / `anyOf` of named refs and scalar types → a generated union (once per node), or `undefined`. */
function resolveNamedRefUnion(
  node: JsonSchemaNode,
  keyword: string,
  raw: unknown[],
  ctx: ResolveContext
): ResolvedType | undefined {
  const found = namedRefMembers(raw, ctx);
  if (!found) return undefined;
  const unresolved = unresolvedMemberRefs(raw, ctx);
  const { name, memberTypes } = declareUnion(node, found.names, ctx, unresolved);
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
  charge(ctx.run);
  if (typeof node.$ref === "string") {
    return resolveRef(node.$ref, ctx);
  }

  // const → a fixed single-value enum (CloudEvents `specversion: { "const": "1.0" }`)
  if (node.const !== undefined) {
    return resolveLiteralValues([node.const], `const(${JSON.stringify(node.const)})`, ctx);
  }

  // enum → logical enum
  if (Array.isArray(node.enum)) {
    return resolveLiteralValues(node.enum, enumLabel(node.enum), ctx);
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
    // A `format` written next to a single member (the null wrapper `anyOf: [{ type: "string" }, { type: "null" }], format: "uuid"`, which is
    // what the JSON Schema emitter writes for `string | null` with @format) applies to that member.
    const firstNode = members.length === 1 && typeof node.format === "string" && members[0].format === undefined ? { ...members[0], format: node.format } : members[0];
    const first = resolveSchemaType(firstNode, { ...ctx, nesting: ctx.nesting + 1 });
    return {
      ...first,
      confidence: members.length === 1 ? first.confidence : "low",
      nullable: hasNull || first.nullable,
      originalType: `${keyword}(${members.length})`,
      lowFromUnresolvedRef: members.length === 1 && first.lowFromUnresolvedRef === true,
    };
  }

  // `type: ["string", "integer"]`: a value of any of the listed types. A scalar-only list is a union; a list with a type no scalar
  // union holds (object, array) keeps its first type at low confidence and names what it dropped.
  if (Array.isArray(node.type)) {
    const listed = [...new Set(node.type.filter((t): t is string => typeof t === "string" && t !== "null"))];
    if (listed.length > 1) {
      const nullable = node.type.includes("null");
      if (listed.every((t) => SCALAR_TYPES.has(t))) {
        const names = [...new Set(listed.map((t) => scalarTypeName(t, node.format, ctx)).filter((n): n is string => n !== undefined))];
        if (names.length > 1) {
          const { name, memberTypes } = declareUnion(node, names, ctx);
          return { type: "union", confidence: "medium", nullable, originalType: `type(${names.length})`, unionName: name, unionMembers: memberTypes };
        }
      }
      if (!TYPE_LIST_WARNED.has(node)) {
        TYPE_LIST_WARNED.add(node);
        const where = ctx.fieldLabel ? `Property ${ctx.fieldLabel}` : "A schema";
        ctx.warnings.push(
          `${where} is typed [${listed.join(", ")}]: only ${listed[0]} was imported (dropped: ${listed.slice(1).join(", ")}); a union cannot hold ${listed.filter((t) => !SCALAR_TYPES.has(t)).join(", ")}`
        );
      }
      const first = resolveSchemaType({ ...node, type: nullable ? [listed[0], "null"] : listed[0] }, ctx);
      return { ...first, confidence: "low" };
    }
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
    run: newRun(),
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

/**
 * What an entity's own schema node (the root, or a `$defs` entry; with its `allOf` members) carries beyond its properties, besides what the
 * importer reads: every vendor / unknown key (verbatim, first definition wins) and the unsupported standard keywords; the document's
 * `$id` / `$schema` (root) or `$schema` and a `title` that says more than the name (a definition), listed as not interpreted and kept as
 * extensions (a definition's `$id` is the resource id its `$ref`s are resolved by: read, not carried); and the deprecated flag.
 */
function entityExtensions(
  node: JsonSchemaNode,
  name: string,
  isRoot: boolean
): { extensions?: Record<string, unknown>; ignoredKeywords?: string[]; deprecated?: true } {
  const sources = schemaSources(node);
  let extensions: Record<string, unknown> | undefined;
  for (const source of sources) {
    for (const [key, value] of Object.entries(captureExtensions(source) ?? {})) {
      if (extensions && Object.prototype.hasOwnProperty.call(extensions, key)) continue;
      setOwn((extensions ??= {}), key, value);
    }
  }
  const found = ignoredKeywordsOf(sources, false) ?? [];
  // The identity / dialect of the document (of a definition: its dialect; its `$id` is the resource id, read by `$ref`), from the node or an allOf member.
  for (const key of isRoot ? (["$schema", "$id"] as const) : (["$schema"] as const)) {
    const holder = sources.find((s) => typeof s[key] === "string");
    if (!holder) continue;
    setOwn((extensions ??= {}), key, holder[key]);
    if (!found.includes(key)) found.push(key);
  }
  // `$defs` / `definitions` are imported as the document's own definitions only at the root; below it (a definition's, an allOf member's) they
  // are not: kept verbatim and reported.
  for (const key of ["$defs", "definitions"] as const) {
    const holder = sources.find((s) => s[key] !== undefined && !(isRoot && s === node));
    if (!holder) continue;
    if (!(extensions && Object.prototype.hasOwnProperty.call(extensions, key))) setOwn((extensions ??= {}), key, holder[key]);
    if (!found.includes(key)) found.push(key);
  }
  // Value keywords that mean something for a string / number / array and nothing for an object: nothing in the IR to put them on. Kept
  // verbatim (first definition wins) and reported like the other unsupported keywords.
  for (const key of ENTITY_UNMAPPED_KEYS) {
    const holder = sources.find((s) => s[key] !== undefined);
    if (!holder) continue;
    if (!(extensions && Object.prototype.hasOwnProperty.call(extensions, key))) setOwn((extensions ??= {}), key, holder[key]);
    if (!found.includes(key)) found.push(key);
  }
  // A title that is only the entity's name adds nothing; one that says more is the schema's own and is kept.
  const title = sources.map((s) => (typeof s.title === "string" ? s.title.trim() : "")).find((t) => t !== "" && t !== name);
  if (title !== undefined && !(extensions && Object.prototype.hasOwnProperty.call(extensions, "title"))) setOwn((extensions ??= {}), "title", title);
  const deprecated = sources.some((s) => s.deprecated === true);
  // An entity-level oneOf / anyOf (alternative `required` sets, a choice between shapes) maps to nothing in the IR: on a FIELD it becomes a
  // union, on an entity it is a constraint over the whole object. Report it like the other unsupported keywords and keep it verbatim.
  let preserved = extensions;
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const holder = sources.find((s) => s[keyword] !== undefined);
    if (!holder) continue;
    if (!found.includes(keyword)) found.push(keyword);
    if (!preserved || !Object.prototype.hasOwnProperty.call(preserved, keyword)) setOwn((preserved ??= {}), keyword, holder[keyword]);
  }
  return {
    ...(preserved ? { extensions: preserved } : {}),
    ...(found.length > 0 ? { ignoredKeywords: found } : {}),
    ...(deprecated ? { deprecated: true as const } : {}),
  };
}

/** Keywords of the value vocabularies that an object schema (an entity) cannot map: kept as extensions and reported (see `entityExtensions`). */
const ENTITY_UNMAPPED_KEYS = [
  "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "format",
] as const;

/** The description of an entity: its node's, else the first allOf member's (an annotation-only member enriches the result, spec Addendum A). */
function entityDescription(node: JsonSchemaNode): string | undefined {
  return schemaSources(node).map((s) => s.description).find((d): d is string => typeof d === "string");
}

const MAX_IGNORED_WARNINGS = 200;

/** Fields whose hoisted keyword appears in several nested members with different values (reported under the same cap). */
const NESTED_CONFLICTS = new WeakMap<object, string[]>();

/** What was folded onto a field from the schemas below it (`x-visibility found on items of R.links was kept on the field`), reported under the same cap. */
const NESTED_NOTES = new WeakMap<object, string[]>();

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
      for (const message of NESTED_NOTES.get(field) ?? []) {
        total += 1;
        if (out.length < MAX_IGNORED_WARNINGS) out.push(message);
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
const DEFINITION_ONLY_KEYS = new Set(["$schema", "$id", "$defs", "definitions", "$ref"]);

/** Keys that define what a shared enum / union IS (its symbols, its members, its text): they are the asset's, not annotations for the fields that use it. */
const KIND_DEFINING_KEYS: Record<"enum" | "union", ReadonlySet<string>> = {
  enum: new Set(["enum", "type", "description"]),
  union: new Set(["oneOf", "anyOf", "description"]),
};

/**
 * The `$defs` entries the given sources `$ref`, followed through chains, as extra annotation sources: a `$ref: "#/$defs/ShortText"` field
 * keeps the (inline) definition's constraints, description, deprecated flag and extensions. A shared enum / union definition has no place of
 * its own for what it carries besides its symbols / members (`x-enum-varnames`, `deprecated`, vendor keys), so those reach the fields that
 * use it the same way (what makes it the asset is left out). They come AFTER the field's own sources, so the property's own siblings win on
 * conflict. A cycle or a chain past MAX_REF_DEPTH stops quietly.
 */
function inlineDefinitionSources(own: JsonSchemaNode[], ctx: ResolveContext): JsonSchemaNode[] {
  const out: JsonSchemaNode[] = [];
  const seen = new Set<JsonSchemaNode>();
  const visit = (source: JsonSchemaNode, depth: number): void => {
    if (typeof source.$ref !== "string" || depth >= MAX_REF_DEPTH) return;
    const def = definitionFor(ctx.definitions, source.$ref);
    if ((def?.kind !== "inline" && def?.kind !== "enum" && def?.kind !== "union") || seen.has(def.node)) return;
    seen.add(def.node);
    const kindKeys = def.kind === "inline" ? undefined : KIND_DEFINING_KEYS[def.kind];
    for (const member of schemaSources(def.node)) {
      charge(ctx.run);
      const view: JsonSchemaNode = {};
      for (const [key, value] of Object.entries(member)) {
        // A title that is only the definition's name adds nothing to the fields that use it.
        if (key === "title" && typeof value === "string" && value.trim() === def.key) continue;
        if (!DEFINITION_ONLY_KEYS.has(key) && !(kindKeys?.has(key) ?? false)) setOwn(view, key, value);
      }
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
    const ctx: ResolveContext = { ...baseCtx, unionStem: `${ownerName}_${name}`, fieldLabel: `${ownerName}.${name}` };
    const resolved = resolveSchemaType(node, ctx);
    const isRequired = requiredSet.has(name);
    // nullable (the column may be NULL) = optional (not in required) OR a null type. The two are kept apart in `nullableType` /
    // `requiredNullable`: a property that is required AND may be null must stay required (`a: T | null`), not become optional (`a?: T`).
    // A property that is ONLY `null` stays what it was (a string at low confidence): no value type to be nullable.
    const nullableValue = resolved.nullable && resolved.originalType !== "null";
    const nullable = resolved.nullable || !isRequired;

    // A property written as `allOf` merges its members: constraints union (first wins per kind), annotations fold on.
    const ownSources = schemaSources(node);
    const sources = [...ownSources, ...inlineDefinitionSources(ownSources, ctx)];
    // A nullable wrapper (`anyOf: [X, { type: "null" }]`) is the field itself: what X carries is the field's own annotation.
    const wrappers = nullableWrapperMembers(sources);
    const annotationSources = [...sources, ...wrappers];
    const constraints: ParsedFieldConstraint[] = [];
    let minValueExclusive: number | undefined;
    let maxValueExclusive: number | undefined;
    for (const source of annotationSources) {
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
      description: annotationSources.find((s) => typeof s.description === "string")?.description,
      confidence: resolved.confidence,
      originalType: resolved.originalType,
      // Heuristic: a required property literally named "id" is the key.
      isKey: isRequired && name === "id",
      ...(nullableValue ? { nullableType: true as const, ...(isRequired ? { requiredNullable: true as const } : {}) } : {}),
      format: resolved.format,
      deprecated: annotationSources.some((s) => s.deprecated === true) || undefined,
      constraints: constraints.length > 0 ? constraints : undefined,
      minValueExclusive,
      maxValueExclusive,
    };

    let extensions: Record<string, unknown> | undefined;
    for (const source of annotationSources) {
      for (const [key, value] of Object.entries(captureExtensions(source, true) ?? {})) {
        if (extensions && Object.prototype.hasOwnProperty.call(extensions, key)) continue;
        setOwn((extensions ??= {}), key, value);
      }
      // A `format` the resolved type did not take (an enum / union / array / a format of another type, or an integer format with no logical
      // type) has no slot on the field: kept verbatim, first definition wins.
      if (typeof source.format === "string" && !formatTaken(source.format, resolved) && !(extensions && Object.prototype.hasOwnProperty.call(extensions, "format"))) {
        setOwn((extensions ??= {}), "format", source.format);
      }
    }
    // What `items` schemas and oneOf / anyOf members (at any depth, with their allOf members and the inline definitions they `$ref`) carry
    // has no node of its own in the IR. It is folded onto this field, never dropped:
    //  - an unsupported standard keyword is lifted under its own name, the first definition wins and a differing later value is reported
    //    (it is also listed in `ignoredKeywords`);
    //  - a vendor / unknown key is kept under its own name, with a note saying where it was found (`<key>@<site>` when the field already
    //    has the key with another value);
    //  - a constraint / description / deprecated flag (element-level, no slot on the field) is kept as `x-<site>-<keyword>`.
    const found = nestedSchemaNodes(sources, new Set(wrappers), ctx);
    const nested = found.nodes.map((n) => n.node);
    const notes: string[] = [];
    const note = (message: string): void => {
      if (!notes.includes(message)) notes.push(message);
    };
    const owner = `${ownerName}.${name}`;
    const keep = (key: string, value: unknown): "kept" | "same" | "differs" | "too-deep" => {
      if (extensions && Object.prototype.hasOwnProperty.call(extensions, key)) {
        return JSON.stringify(extensions[key]) === JSON.stringify(value) ? "same" : "differs";
      }
      // An extension nested past MAX_LITERAL_DEPTH cannot be written into the generated TypeSpec (it would be left out there): say so here.
      if (nestsDeeperThan(value, MAX_LITERAL_DEPTH)) {
        note(`${key} of ${owner} nests deeper than ${MAX_LITERAL_DEPTH} levels and was not kept`);
        return "too-deep";
      }
      setOwn((extensions ??= {}), key, value);
      return "kept";
    };
    const hoisted = new Set<string>();
    for (const { site, node: source } of found.nodes) {
      for (const [key, value] of Object.entries(source)) {
        if (NESTED_CONSUMED_KEYS.has(key)) continue;
        if (IGNORED_SCHEMA_KEYWORDS.has(key)) {
          if (extensions && Object.prototype.hasOwnProperty.call(extensions, key)) {
            if (hoisted.has(key) && JSON.stringify(extensions[key]) !== JSON.stringify(value)) {
              const list = NESTED_CONFLICTS.get(field) ?? [];
              if (!list.includes(key)) list.push(key);
              NESTED_CONFLICTS.set(field, list);
            }
            continue;
          }
          hoisted.add(key);
          setOwn((extensions ??= {}), key, value);
          continue;
        }
        // A format the importer turns into a logical type (date-time -> utcDateTime) is part of the element's type, already read.
        if (key === "format" && formatIsInterpreted(value)) continue;
        if (ELEMENT_KEYS.has(key) || key === "format") {
          const kept = `x-${siteKey(site)}-${key}`;
          if (keep(kept, value) === "kept" && key !== "title") {
            note(`${key} found on ${site} of ${owner} was kept on the field as ${kept} (the IR has no element-level ${key})`);
          }
          continue;
        }
        // A vendor / unknown key. The reserved keys have their own round trip on the FIELD's own node only: here they are plain extensions.
        const reserved = RESERVED_EXTENSION_KEYS.has(key);
        const outcome = reserved ? "differs" : keep(key, value);
        if (outcome === "kept") note(`${key} found on ${site} of ${owner} was kept on the field`);
        else if (outcome === "differs") {
          const renamed = `${key}@${site}`;
          if (keep(renamed, value) === "kept") {
            note(
              reserved
                ? `${key} found on ${site} of ${owner} was kept on the field as ${renamed} (it is only read on the field's own node)`
                : `${key} found on ${site} of ${owner} differs from the field's own value; kept on the field as ${renamed}`
            );
          }
        }
      }
    }
    // An inline object's own `properties` / `required` are not imported as fields (it maps to the `object` type): kept verbatim on the field.
    const inlineKept: string[] = [];
    for (const source of annotationSources) {
      for (const key of ["properties", "required"] as const) {
        const value = source[key];
        const filled = key === "properties" ? isSchemaObject(value) && Object.keys(value).length > 0 : Array.isArray(value) && value.length > 0;
        if (filled && keep(key, value) === "kept") inlineKept.push(key);
      }
    }
    if (inlineKept.length > 0) {
      note(`${inlineKept.join(" and ")} of the inline object ${owner} ${inlineKept.length > 1 ? "are" : "is"} not imported as fields; kept verbatim on the field`);
    }
    for (const place of found.tooDeep) {
      note(`The schema at ${place} of ${owner} is nested deeper than ${MAX_NESTED_DEPTH} levels and was not scanned for keywords`);
    }
    if (notes.length > 0) NESTED_NOTES.set(field, notes);
    if (extensions) field.extensions = extensions;
    const ignoredKeywords = ignoredKeywordsOf([...annotationSources], true, nested);
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
function parseStructured(content: string): { value: JsonSchemaNode | null; message?: string; tooBig?: boolean } {
  try {
    return { value: JSON.parse(content) };
  } catch {
    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return { value: null };
    // Bounded parse: a YAML alias fan-out is refused with its own message, never expanded (see safe-yaml.ts).
    const parsed = parseYamlBounded(trimmed);
    if (parsed.ok) return { value: parsed.value as JsonSchemaNode };
    return parsed.kind === "syntax" ? { value: null } : { value: null, message: parsed.message, ...(parsed.kind === "size" ? { tooBig: true } : {}) };
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
export function parseJsonSchemaDocument(rawContent: string, budget?: ResolveBudget): Result<MultiEntityImportResult> {
  return parseGuarded(rawContent, undefined, budget);
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
  rawContent: string,
  budget?: ResolveBudget
): Result<{ doc: MultiEntityImportResult; definitions: Map<string, DefinitionIndexEntry> }> {
  const definitions = new Map<string, DefinitionIndexEntry>();
  const parsed = parseGuarded(rawContent, definitions, budget);
  if (!parsed.success) return parsed;
  return ok({ doc: parsed.data, definitions });
}

function parseGuarded(rawContent: string, outIndex?: Map<string, DefinitionIndexEntry>, budget?: ResolveBudget): Result<MultiEntityImportResult> {
  try {
    return importJsonSchemaDocument(stripBom(rawContent), outIndex, budget);
  } catch (error) {
    if (error instanceof ResolveBudgetError) {
      return err({
        code: "PARSE_ERROR",
        message: "The schema is too large to resolve: its references and allOf members expand into too many steps",
        suggestedFix: "Flatten the repeated allOf / $ref chains, or split the schema into smaller documents.",
      });
    }
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

function importJsonSchemaDocument(content: string, outIndex?: Map<string, DefinitionIndexEntry>, budget?: ResolveBudget): Result<MultiEntityImportResult> {
  const { value: schema, message: rejected, tooBig } = parseStructured(content);
  if (schema === null) {
    return err({
      code: "PARSE_ERROR",
      message: rejected ?? "Invalid JSON: could not parse JSON Schema",
      suggestedFix: tooBig
        ? "Convert the schema to JSON (accepted up to 2 MB), or split it into smaller documents."
        : rejected
          ? "Write the repeated parts out in full instead of using YAML aliases, or use $ref to a definition."
          : "Ensure the content is a valid JSON Schema document (JSON or YAML).",
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
    run: newRun(budget),
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
      description: entityDescription(schema),
      fields: buildFields(rootMembers, ctx, rootEntityName),
      ...(rootExtends ? { extends: rootExtends } : {}),
      ...entityExtensions(schema, rootEntityName, true),
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
        description: entityDescription(def.node),
        fields: buildFields(members, ctx, def.assetName),
        ...(defExtends ? { extends: defExtends } : {}),
        ...entityExtensions(def.node, def.assetName, false),
        sourceFormat: "json-schema",
        originalContent: content,
      });
    } else if (def.kind === "enum") {
      const parsedEnum: ParsedEnum = {
        name: def.assetName,
        // `kind: "enum"` is only assigned to all-string enums (indexDefinitions).
        values: boundEnumSymbols([...new Set((def.node.enum ?? []).filter((v) => v !== null) as string[])], def.assetName, warnings, def.node),
      };
      if (typeof def.node.description === "string") parsedEnum.description = def.node.description;
      // What the definition carries besides its symbols has no place on a shared enum row: kept here, and on every field that uses it.
      const enumExtensions = captureExtensions(def.node, true);
      const enumIgnored = ignoredKeywordsOf([def.node], true);
      if (def.node.deprecated === true) parsedEnum.deprecated = true;
      if (enumExtensions) parsedEnum.extensions = enumExtensions;
      if (enumIgnored) parsedEnum.ignoredKeywords = enumIgnored;
      const carried = [...(parsedEnum.deprecated ? ["deprecated"] : []), ...Object.keys(enumExtensions ?? {})];
      if (carried.length > 0) {
        const shown = carried.length > 10 ? `${carried.slice(0, 10).join(", ")} and ${carried.length - 10} more` : carried.join(", ");
        warnings.push(`Enum \`${def.assetName}\`: ${shown} ${carried.length === 1 ? "is" : "are"} kept on every field that uses it (a shared enum has no place of its own for ${carried.length === 1 ? "it" : "them"})`);
      }
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
  // The dialect and nested definitions of a definition that is no entity / enum (an inline definition or a shared union) belong to no asset:
  // reported, not carried.
  for (const def of definitions.values()) {
    if (def.kind !== "inline" && def.kind !== "union") continue;
    for (const key of ["$schema", "$defs", "definitions"] as const) {
      if (def.node[key] !== undefined) warnings.push(`Definition \`${def.key}\`: JSON Schema keyword \`${key}\` is not supported and was ignored`);
    }
  }

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
  budgetPreservedValues(entities, warnings);

  const result: MultiEntityImportResult = {
    sourceFormat: "json-schema",
    entities,
    ...(rootIsEntity && rootEntityName ? { rootEntityName } : {}),
    enums,
    scalars: [],
    unions: [...sharedUnions, ...unions],
    warnings,
  };
  // Backstop for the copies the keyword budget above does not cover (an enum's values, a pattern, a constant on every field that names it).
  const tooLarge = importResponseTooLargeMessage(result, content.length);
  if (tooLarge) return err({ code: "PARSE_ERROR", message: tooLarge, suggestedFix: "Reference large enums, patterns and constants from fewer fields, or split the schema." });
  return ok(result);
}

export function parseJsonSchema(content: string): Result<ParsedEntity> {
  const doc = parseJsonSchemaDocument(content);
  if (!doc.success) return doc;
  return ok(pickRootEntity(doc.data));
}
