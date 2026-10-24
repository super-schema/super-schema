import { setOwn } from "@/lib/event-specs/own-property";

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

export function qualifiedName(ref: EntityRef): string {
  return `${ref.domain}/${ref.product}/${ref.entity}`;
}

export function parseQualifiedName(s: string): EntityRef | undefined {
  if (typeof s !== "string") return undefined;
  const parts = s.split("/");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return undefined;
  return { domain: parts[0], product: parts[1], entity: parts[2] };
}

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
export function readFieldReference(decorators: unknown): EntityRef | { legacyName: string } | undefined {
  if (!decorators || typeof decorators !== "object" || Array.isArray(decorators)) return undefined;
  const d = decorators as Record<string, unknown>;
  const qualified = ownString(d, "referencedQualifiedName");
  const parsed = qualified ? parseQualifiedName(qualified) : undefined;
  if (parsed) {
    const entityId = ownString(d, "referencedEntityId");
    const pinnedVersion = ownString(d, "referencedEntityVersion");
    const ref: EntityRef = { domain: parsed.domain, product: parsed.product, entity: parsed.entity };
    if (entityId) ref.entityId = entityId;
    if (pinnedVersion) ref.pinnedVersion = pinnedVersion;
    return ref;
  }
  const legacyName = ownString(d, "referencedEntityName");
  return legacyName ? { legacyName } : undefined;
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
