import { setOwn } from "@/lib/event-specs/own-property";

/**
 * How a field holds an entity reference: it IS one (`direct`, type `reference`), it is an array of them (`array`, `arrayElementType:
 * "reference"`) or a map of them (`map`, `mapValueType: "reference"`). The `referenced*` keys sit on the field's decorators in every shape.
 */
export type ReferenceShape = "direct" | "array" | "map";

/** Placeholder segment for a reference target that has no domain / product. */
export const TENANT_PLACEHOLDER = "_tenant";

/**
 * A fully qualified reference to another entity. `entityId` is the stable identity (absent when only a name was
 * parsed); `pinnedVersion` is stored only when the author pinned one.
 */
export type EntityRef = {
  entityId?: string;
  domain: string;
  product: string;
  entity: string;
  pinnedVersion?: string;
};

/** A tenant entity the reference picker offers; `domain` / `product` make its qualified name (`_tenant` stands in for a missing one). */
export type PickableEntity = { id: string; name: string; domain?: string; product?: string };

/**
 * A name inside the qualified string: `%` is `%25` and `/` is `%2F`, so a segment can never add a separator. A name without either is
 * unchanged, which keeps every string stored before the encoding existed valid.
 */
const encodeSegment = (segment: string): string => segment.replace(/%/g, "%25").replace(/\//g, "%2F");
/** The inverse of {@link encodeSegment}, in one pass (`%2525` is `%25`). Any other `%` is left as it is. */
const decodeSegment = (segment: string): string => segment.replace(/%(2F|25)/gi, (_match, hex: string) => (hex === "25" ? "%" : "/"));

/** `domain/product/entity` with each name encoded ({@link encodeSegment}): always exactly three parts, whatever the names hold. */
export function qualifiedName(ref: EntityRef): string {
  return `${encodeSegment(ref.domain)}/${encodeSegment(ref.product)}/${encodeSegment(ref.entity)}`;
}

/** `domain / product / entity` as a person reads it: the names as they are (never the encoding). */
export function describeEntityRef(ref: Pick<EntityRef, "domain" | "product" | "entity">): string {
  return `${ref.domain} / ${ref.product} / ${ref.entity}`;
}

/** {@link describeEntityRef} of a stored qualified string; anything that is not one is returned as it is. */
export function describeQualifiedName(qualified: string): string {
  const parsed = parseQualifiedName(qualified);
  return parsed ? describeEntityRef(parsed) : qualified;
}

/**
 * The segments of a qualified string. `entityNameHint` is the entity's own name (a reference stores it beside the string): a string
 * written BEFORE names were encoded can hold the raw `/` of an entity name (four or more parts), which the hint recovers when the rest is
 * exactly a domain and a product.
 */
export function parseQualifiedName(s: string, entityNameHint?: string): EntityRef | undefined {
  if (typeof s !== "string") return undefined;
  const parts = s.split("/");
  if (parts.length === 3 && parts.every((p) => p.length > 0)) {
    return { domain: decodeSegment(parts[0]), product: decodeSegment(parts[1]), entity: decodeSegment(parts[2]) };
  }
  if (entityNameHint && parts.length > 3 && s.endsWith(`/${entityNameHint}`)) {
    const head = s.slice(0, s.length - entityNameHint.length - 1).split("/");
    if (head.length === 2 && head.every((p) => p.length > 0)) {
      return { domain: decodeSegment(head[0]), product: decodeSegment(head[1]), entity: entityNameHint };
    }
  }
  return undefined;
}

/**
 * A reference that is only a name: a legacy name-only reference, or a stored one whose qualified string cannot be read. It still carries
 * the entity id and the pin when the field has them (the id settles it, and the pin is not lost with the parse).
 */
export type LegacyEntityRef = { legacyName: string; entityId?: string; pinnedVersion?: string };

function ownString(obj: Record<string, unknown>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The decorator keys that make up a reference (identity, name, qualified name, pin): all of them go when the field stops being one. */
export const REFERENCE_DECORATOR_KEYS: ReadonlyArray<string> = [
  "referencedEntityId",
  "referencedEntityName",
  "referencedQualifiedName",
  // The three names of the qualified name, stored on their own (raw, never encoded): reading a reference never needs to parse the string.
  "referencedDomain",
  "referencedProduct",
  "referencedEntity",
  "referencedEntityVersion",
];

/**
 * Whether a field of `type` carries an entity reference in its decorators: a `reference`, an `array` whose elements are references
 * (`arrayElementType: "reference"`) or a `map` whose values are (`mapValueType: "reference"`). Anything else does not, whatever its
 * decorators still hold: the `referenced*` keys of a field that was retyped are stale data, and every reader of them asks this first.
 * `type` undefined (a caller that does not know it) says yes: the answer it always had.
 */
export function holdsEntityReference(type: string | undefined, decorators: unknown): boolean {
  if (type === undefined || type === "reference") return true;
  if (!decorators || typeof decorators !== "object" || Array.isArray(decorators)) return false;
  const d = decorators as Record<string, unknown>;
  if (type === "array") return ownString(d, "arrayElementType") === "reference";
  if (type === "map") return ownString(d, "mapValueType") === "reference";
  return false;
}

/**
 * What a reference field points at, for telling that it was re-pointed: the entity id, or (a name-only reference, which has none) the
 * name. A rename of the entity keeps the id, so it is not a new target.
 */
export function referenceTargetKey(decorators: Record<string, unknown>): string | undefined {
  const id = ownString(decorators, "referencedEntityId");
  if (id) return `id:${id}`;
  const name = ownString(decorators, "referencedEntityName");
  return name ? `name:${name}` : undefined;
}

/** A copy of `decorators` without the reference keys; everything else is kept. */
export function withoutReferenceKeys(decorators: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(decorators)) {
    if (REFERENCE_DECORATOR_KEYS.includes(key)) continue;
    setOwn(out, key, decorators[key]);
  }
  return out;
}

/**
 * Reads the reference stored on a field's decorators. A qualified reference yields an `EntityRef`; a name-only
 * (pre-qualification) one yields `{ legacyName }`.
 */
export function readFieldReference(decorators: unknown): EntityRef | LegacyEntityRef | undefined {
  if (!decorators || typeof decorators !== "object" || Array.isArray(decorators)) return undefined;
  const d = decorators as Record<string, unknown>;
  const entityId = ownString(d, "referencedEntityId");
  const pinnedVersion = ownString(d, "referencedEntityVersion");
  const name = ownString(d, "referencedEntityName");
  // The three names stored on their own come first (nothing to parse); the qualified string is read for rows stored before they existed.
  const domain = ownString(d, "referencedDomain");
  const product = ownString(d, "referencedProduct");
  const entity = ownString(d, "referencedEntity");
  const qualified = ownString(d, "referencedQualifiedName");
  const parsed: Pick<EntityRef, "domain" | "product" | "entity"> | undefined =
    domain && product && entity ? { domain, product, entity } : qualified ? parseQualifiedName(qualified, name) : undefined;
  if (parsed) {
    const ref: EntityRef = { domain: parsed.domain, product: parsed.product, entity: parsed.entity };
    if (entityId) ref.entityId = entityId;
    if (pinnedVersion) ref.pinnedVersion = pinnedVersion;
    return ref;
  }
  if (!name) return undefined;
  const legacy: LegacyEntityRef = { legacyName: name };
  if (entityId) legacy.entityId = entityId;
  if (pinnedVersion) legacy.pinnedVersion = pinnedVersion;
  return legacy;
}

/**
 * Upgrades a name-only (legacy) reference to the qualified form once it resolved to exactly one entity. Other decorator
 * keys are kept; a version is never added, and a pin the decorators already carry is preserved.
 */
export function upgradeLegacyReference(decorators: Record<string, unknown>, resolved: EntityRef): Record<string, unknown> {
  const existingPin = ownString(decorators, "referencedEntityVersion");
  const ref: EntityRef = { domain: resolved.domain, product: resolved.product, entity: resolved.entity };
  if (resolved.entityId) ref.entityId = resolved.entityId;
  if (existingPin) ref.pinnedVersion = existingPin;
  return writeFieldReference(decorators, ref);
}

/** Returns a copy of `decorators` carrying `ref`; a stale version pin is dropped unless `ref` pins one. */
export function writeFieldReference(decorators: Record<string, unknown>, ref: EntityRef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(decorators)) {
    if (key === "referencedEntityVersion") continue;
    setOwn(out, key, decorators[key]);
  }
  if (ref.entityId) setOwn(out, "referencedEntityId", ref.entityId);
  setOwn(out, "referencedEntityName", ref.entity);
  setOwn(out, "referencedQualifiedName", qualifiedName(ref));
  setOwn(out, "referencedDomain", ref.domain);
  setOwn(out, "referencedProduct", ref.product);
  setOwn(out, "referencedEntity", ref.entity);
  if (ref.pinnedVersion) setOwn(out, "referencedEntityVersion", ref.pinnedVersion);
  return out;
}

/** `JSON.stringify` with the keys of every object in order, so two objects with the same content compare equal whatever order their keys were written in. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** What the type picker's reference prompt reports: the typed or picked name, and for a PICKED entity its id and qualified name. */
export type ReferencePick = {
  referencedEntityName?: string;
  referencedEntityId?: string;
  referencedQualifiedName?: string;
};

/**
 * The decorators of a reference field after the author chose its target in the type picker.
 * - A PICKED entity (id and a well-formed qualified name) is written fully qualified (`writeFieldReference`): id, name, qualified name.
 *   No version is ever written here (only a pin stores one), and a pin of the previous target is dropped with it.
 * - A name that was only typed stays name-only, as a legacy reference does (nothing was picked, so nothing is qualified), and the id,
 *   qualified name and pin of an earlier target are dropped so they cannot point at the entity it used to mean.
 * - Without a name the decorators are returned as an untouched copy.
 * Other decorator keys are kept.
 */
export function applyReferencePick(decorators: Record<string, unknown>, pick: ReferencePick): Record<string, unknown> {
  const parsed = pick.referencedQualifiedName ? parseQualifiedName(pick.referencedQualifiedName) : undefined;
  if (parsed && pick.referencedEntityId) return writeFieldReference(decorators, { ...parsed, entityId: pick.referencedEntityId });

  const name = pick.referencedEntityName?.trim();
  if (!name) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(decorators)) setOwn(copy, key, decorators[key]);
    return copy;
  }
  const out = withoutReferenceKeys(decorators);
  setOwn(out, "referencedEntityName", name);
  return out;
}

/**
 * True when applying `pick` would write exactly the decorators the field already has: the same target picked again, with no pin to drop.
 * The pin of the same target is NOT unchanged (a pick writes no pin), so re-picking a pinned reference is a change.
 */
export function referencePickChangesNothing(decorators: Record<string, unknown>, pick: ReferencePick): boolean {
  return canonicalJson(applyReferencePick(decorators, pick)) === canonicalJson(decorators);
}
