/**
 * TypeSpec source -> field rows: the pure part of the sync (Task 16).
 *
 * The entity's TypeSpec source is canonical, but a field row carries more than the text can say (the data category of a
 * classification, the raw unresolved `$ref`, importer-only format bindings, decorator keys written by other features). The sync
 * therefore MERGES: every field that continues to exist starts from its stored `decorators` and only the keys the source owns are
 * overwritten. Nothing here touches the database; `applyTypeSpecAction` stays the thin, tenant-checked, audited wrapper.
 *
 * Key ownership inside `decorators` (S = overwritten from the source text, P = preserved when the source does not speak to it):
 *   S  typespec.identity.{secret,format}      P  typespec.identity.key while the field is still a key, other identity keys
 *   S  typespec.validation.*                  P  validation.pattern of an enum (its symbols ride there), any other validation key
 *   S  typespec.wireFormat.{encode,encodeSubType}, typespec.documentation.{summary,deprecated}, typespec.visibility
 *   S  typespec.extensions.openapi (the generic `@extension` entries)       P  other extension buckets (xml, ...)
 *   S  danglingRef / referencedEntityName of a dangling field (decoded from the `$ref` / `items` extension the generator writes)
 *   S  arrayElementType when the source names one                          P  otherwise, while the type is unchanged
 *   S  governance.{classification,pii,retentionPolicy,anonymization,qualityRule,sourceMapping,avroLogicalType,avroOrder,
 *      partitionHint,indexHint,clusterHint,deprecation} (compiled path only: that path reads them from the real decorators)
 *   P  governance.{dataClass,dataCategory,protobufFieldNumber,protobufOneofGroup,avroFixedSize} (the generator does not emit them);
 *      the three format bindings are overlaid when the source states them
 *   P  every other key (`classification`, `semantics`, `evolution`, `enumName`, `unionName`, `mapKeyType`, unknown keys, ...)
 * A key whose meaning the edit invalidated is dropped: when the type changes, the type-bound keys (reference target, enum / union /
 * map details, the dangling marker) go; a dangling marker is also dropped once the source no longer carries the `$ref` extension
 * (the field was resolved), exactly the `activeDanglingRef` / `decoratorsAfterFieldEdit` semantics of the field editors.
 */

import { classificationFromDecorators, setOwn } from "@/lib/compiler/governance-decorators";
import type { FieldGovernanceInfo } from "@/lib/compiler/typespec-compiler";
import { activeDanglingRef } from "@/lib/field-dangling";
import { refToEntityName } from "@/lib/importers/jsonschema.importer";

type Rec = Record<string, unknown>;

/** A field as the parser reads it from the source text. */
export interface SyncSourceField {
  name: string;
  type: string;
  isOptional: boolean;
  isKey: boolean;
  decorators: Rec;
  arrayElementType?: string;
}

/** The stored field row, as far as the merge reads it. */
export interface SyncExistingField {
  type: string;
  nullable: boolean;
  isKey: boolean;
  description: string;
  classification: string | null;
  decorators: unknown;
}

export interface MergedField {
  type: string;
  nullable: boolean;
  isKey: boolean;
  description: string;
  classification: string | null;
  decorators: Rec;
}

export interface MergeOptions {
  /** Governance decorator values of this field from the real-compiler path. */
  governance?: FieldGovernanceInfo;
  /** True on the compiler path (it reads governance for every field, `governance` may be undefined for one without any). Defaults to `governance !== undefined`. */
  governanceKnown?: boolean;
}

export const GENERIC_DANGLING_REASON = "unresolved reference";

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Deep copy of JSON-shaped data; a `__proto__` key stays an own data key. */
function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as unknown as T;
  if (isRec(value)) {
    const out: Rec = {};
    for (const key of Object.keys(value)) setOwn(out, key, cloneJson(value[key]));
    return out as T;
  }
  return value;
}

/** Structural equality of JSON-shaped data (object key order is irrelevant). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isRec(a) && isRec(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Source type: the dangling encoding
// ---------------------------------------------------------------------------

interface MappedSource {
  type: string;
  arrayElementType?: string;
  /** Generic extensions left after the `$ref` / `items` pair was consumed. */
  extensions: Rec;
  dangling?: { ref: string; element: boolean };
}

/**
 * `unknown` as the parser reports it: the regex parser says `unknown`, the real-compiler reader maps TypeSpec's `unknown` to the generic
 * `string`. Either one carrying the `$ref` extension is the dangling encoding (nothing else writes a `$ref` extension on a field).
 */
const isUnknownCarrier = (type: string | undefined) => type === "unknown" || type === "string";

/**
 * The type the source text means. The generator spells a dangling reference as `unknown` + `@extension("$ref", "<raw>")` (direct) or
 * `unknown[]` + `@extension("items", #{`$ref`: "<raw>"})` (array items): map that back to `reference` / array of `reference`.
 */
function mapSourceField(source: SyncSourceField): MappedSource {
  const extensions: Rec = {};
  const raw = isRec(source.decorators.extensions) ? source.decorators.extensions : {};
  for (const key of Object.keys(raw)) setOwn(extensions, key, raw[key]);

  const direct = extensions.$ref;
  if (isUnknownCarrier(source.type) && typeof direct === "string" && direct !== "") {
    delete extensions.$ref;
    return { type: "reference", extensions, dangling: { ref: direct, element: false } };
  }
  const items = extensions.items;
  if (source.type === "array" && isUnknownCarrier(source.arrayElementType) && isRec(items)) {
    const keys = Object.keys(items);
    if (keys.length === 1 && keys[0] === "$ref" && typeof items.$ref === "string" && items.$ref !== "") {
      delete extensions.items;
      return { type: "array", arrayElementType: "reference", extensions, dangling: { ref: items.$ref, element: true } };
    }
  }
  return { type: source.type, arrayElementType: source.arrayElementType, extensions };
}

// ---------------------------------------------------------------------------
// Source-owned decorator buckets (what the text can express)
// ---------------------------------------------------------------------------

const VALIDATION_KEYS = ["minLength", "maxLength", "minValue", "maxValue", "minValueExclusive", "maxValueExclusive", "pattern", "minItems", "maxItems"] as const;

/** Owned subkeys of each `typespec.*` bucket; `visibility` and `extensions.openapi` are owned whole. */
const OWNED: Record<string, readonly string[]> = {
  identity: ["secret", "format"],
  validation: VALIDATION_KEYS,
  wireFormat: ["encode", "encodeSubType"],
  documentation: ["summary", "deprecated"],
};

function derivedBuckets(d: Rec): Record<string, Rec> {
  const identity: Rec = {};
  if (d.secret) identity.secret = true;
  if (d.format) identity.format = d.format;
  const validation: Rec = {};
  for (const key of VALIDATION_KEYS) {
    if (key === "pattern" ? d.pattern : d[key] != null) validation[key] = d[key];
  }
  const wireFormat: Rec = {};
  if (d.encode) wireFormat.encode = d.encode;
  if (d.encodeSubType) wireFormat.encodeSubType = d.encodeSubType;
  const documentation: Rec = {};
  if (d.summary) documentation.summary = d.summary;
  if (d.deprecated) documentation.deprecated = d.deprecated;
  const out: Record<string, Rec> = { identity, validation, wireFormat, documentation };
  if (d.visibility && Array.isArray(d.visibility)) out.visibility = { phases: d.visibility };
  return out;
}

/** Keys that only mean something for the type they were written for. */
const TYPE_BOUND_KEYS = ["referencedEntityName", "danglingRef", "enumName", "enumValues", "unionName", "unionMembers", "mapKeyType", "mapValueType"] as const;

// Governance keys the source owns (deleted when it no longer states them). Everything else in `governance` (dataClass, dataCategory and
// the format bindings avroFixedSize / protobufFieldNumber / protobufOneofGroup, which the generator never writes) is only overlaid.
const GOVERNANCE_SOURCE_OWNED = [
  "classification", "pii", "retentionPolicy", "anonymization", "qualityRule", "sourceMapping", "avroLogicalType", "avroOrder",
  "partitionHint", "indexHint", "clusterHint", "deprecation",
] as const;

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

const stripNull = (t: string | undefined) => (t === undefined ? t : t.replace(/^\s*null\s*\|\s*|\s*\|\s*null\s*$/g, "").trim());

/**
 * A resolved reference is written as the bare model name (`Customer`, `Customer[]`, `Customer | null`) and both parsers read it back as
 * that name, never as `reference`. When that name EQUALS the stored target (exact, case-sensitive) the field is unchanged: it is read as
 * `reference` / array of `reference` again so the target survives. A different name is a real edit and is left as written.
 */
function resolvedTargetAsStored(existing: SyncExistingField | null, source: SyncSourceField): SyncSourceField {
  if (!existing || !isRec(existing.decorators)) return source;
  const target = existing.decorators.referencedEntityName;
  if (typeof target !== "string" || target === "") return source;
  if (existing.type === "reference" && stripNull(source.type) === target) return { ...source, type: "reference" };
  if (existing.type === "array" && existing.decorators.arrayElementType === "reference" && source.type === "array" && stripNull(source.arrayElementType) === target) {
    return { ...source, arrayElementType: "reference" };
  }
  return source;
}

/** The field row the source text means, given the stored row (null for a field the source adds). Pure; never mutates its inputs. */
export function mergeSyncedField(existing: SyncExistingField | null, rawSource: SyncSourceField, opts: MergeOptions = {}): MergedField {
  const source = resolvedTargetAsStored(existing, rawSource);
  const out: Rec = isRec(existing?.decorators) ? cloneJson(existing.decorators as Rec) : {};
  const mapped = mapSourceField(source);
  const typeChanged = existing !== null && existing.type !== mapped.type;
  const hadMarker = existing !== null && activeDanglingRef(existing.type, existing.decorators as Rec | null) !== undefined;
  const priorMarker = isRec(out.danglingRef) ? out.danglingRef : undefined;

  // A new type invalidates what was bound to the old one.
  const oldWasEnum = existing?.type === "enum";
  if (typeChanged) {
    for (const key of TYPE_BOUND_KEYS) delete out[key];
    if (isRec(out.typespec) && isRec(out.typespec.validation) && oldWasEnum) delete out.typespec.validation.pattern;
  }

  // --- typespec.* buckets: overwrite the owned keys, keep the rest ---
  const typespec: Rec = isRec(out.typespec) ? out.typespec : {};
  const derived = derivedBuckets(source.decorators);
  for (const bucket of ["identity", "validation", "wireFormat", "documentation"]) {
    const next: Rec = isRec(typespec[bucket]) ? (typespec[bucket] as Rec) : {};
    for (const key of OWNED[bucket]) {
      // An enum keeps its symbols in `validation.pattern` (the generator does not emit @pattern for it): the stored value is the truth.
      if (bucket === "validation" && key === "pattern" && oldWasEnum && !typeChanged && !has(derived.validation, "pattern")) continue;
      delete next[key];
    }
    Object.assign(next, derived[bucket]);
    // `identity.key` mirrors Field.isKey: keep it only while the field is a key.
    if (bucket === "identity" && !source.isKey) delete next.key;
    if (Object.keys(next).length > 0) typespec[bucket] = next;
    else delete typespec[bucket];
  }
  if (derived.visibility) typespec.visibility = derived.visibility;
  else delete typespec.visibility;

  const extBucket: Rec = isRec(typespec.extensions) ? (typespec.extensions as Rec) : {};
  if (Object.keys(mapped.extensions).length > 0) setOwn(extBucket, "openapi", mapped.extensions);
  else delete extBucket.openapi;
  if (Object.keys(extBucket).length > 0) typespec.extensions = extBucket;
  else delete typespec.extensions;

  if (Object.keys(typespec).length > 0) out.typespec = typespec;
  else delete out.typespec;

  // --- type target: dangling marker, referenced entity, element type ---
  if (mapped.dangling) {
    out.danglingRef = {
      ref: mapped.dangling.ref,
      ...(mapped.dangling.element ? { element: true } : {}),
      reason: typeof priorMarker?.reason === "string" ? priorMarker.reason : GENERIC_DANGLING_REASON,
    };
    out.referencedEntityName = refToEntityName(mapped.dangling.ref);
  } else {
    delete out.danglingRef;
    if (hadMarker) {
      // The target was derived from the raw reference the source no longer carries.
      delete out.referencedEntityName;
      if (!mapped.arrayElementType) delete out.arrayElementType;
    }
  }
  // An array whose element moved off the reference no longer has that target.
  if (existing?.type === "array" && mapped.type === "array" && (existing.decorators as Rec | null)?.arrayElementType === "reference" && mapped.arrayElementType !== "reference") {
    delete out.referencedEntityName;
  }
  if (mapped.arrayElementType) out.arrayElementType = mapped.arrayElementType;
  else if (mapped.type !== "array") delete out.arrayElementType;

  // --- classification ---
  const governanceInfo = opts.governance;
  const sourceLevel = governanceInfo?.classification ?? classificationFromDecorators(source.decorators) ?? null;
  const classification = sourceLevel ?? existing?.classification ?? null;
  const levelChanged = existing !== null && sourceLevel !== null && sourceLevel !== existing.classification;
  if (levelChanged) {
    if (isRec(out.classification)) out.classification = { ...out.classification, level: sourceLevel };
  }

  // --- governance ---
  let governance: Rec | undefined = isRec(out.governance) ? out.governance : undefined;
  if (opts.governanceKnown ?? governanceInfo !== undefined) {
    governance = governance ?? {};
    for (const key of GOVERNANCE_SOURCE_OWNED) delete governance[key];
    for (const [key, value] of Object.entries(governanceInfo ?? {})) {
      if (value !== undefined) governance[key] = value;
    }
  }
  // The data class mirrors the level while it did; once the source moves the level it follows, otherwise it is the user's.
  if (levelChanged && governance && governance.dataClass === existing.classification) governance.dataClass = sourceLevel;
  if (governance && Object.keys(governance).length > 0) out.governance = governance;
  else delete out.governance;

  // --- documentation text mirror ---
  const doc = source.decorators.doc;
  if (typeof doc === "string" && doc !== "" && isRec(out.semantics) && has(out.semantics, "description")) {
    out.semantics = { ...out.semantics, description: doc };
  }

  return {
    type: mapped.type,
    nullable: source.isOptional,
    isKey: source.isKey,
    description: (doc as string | undefined) ?? existing?.description ?? "",
    classification,
    decorators: out,
  };
}

/** Whether the merged row differs from the stored one (a no-op re-sync of unchanged source is false). */
export function fieldNeedsUpdate(existing: SyncExistingField, merged: MergedField, source: SyncSourceField): boolean {
  return (
    existing.type !== merged.type ||
    existing.nullable !== merged.nullable ||
    existing.isKey !== merged.isKey ||
    Boolean(source.decorators.doc && existing.description !== source.decorators.doc) ||
    merged.classification !== existing.classification ||
    !jsonEqual(isRec(existing.decorators) ? existing.decorators : {}, merged.decorators)
  );
}

// ---------------------------------------------------------------------------
// Entity-level extensions
// ---------------------------------------------------------------------------

export type EntityExtensionsChange = { kind: "none" } | { kind: "set"; value: Rec } | { kind: "clear" };

/** What to do with `metadata.custom.extensions` so it equals the model's extensions parsed from the source. */
export function entityExtensionsChange(metadata: unknown, source: Rec | null | undefined): EntityExtensionsChange {
  const custom = isRec(metadata) && isRec(metadata.custom) ? metadata.custom : undefined;
  const stored = isRec(custom?.extensions) && Object.keys(custom.extensions as Rec).length > 0 ? (custom?.extensions as Rec) : undefined;
  const wanted: Rec | undefined = isRec(source) && Object.keys(source).length > 0 ? cloneJson(source) : undefined;
  if (wanted === undefined) return stored === undefined ? { kind: "none" } : { kind: "clear" };
  return stored !== undefined && jsonEqual(stored, wanted) ? { kind: "none" } : { kind: "set", value: wanted };
}
