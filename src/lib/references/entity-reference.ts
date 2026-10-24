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

/** What the type picker's reference prompt reports: the typed or picked name, and for a PICKED entity its id and qualified name. */
export type ReferencePick = {
  referencedEntityName?: string;
  referencedEntityId?: string;
  referencedQualifiedName?: string;
};

const REFERENCE_KEYS = new Set(["referencedEntityId", "referencedEntityName", "referencedQualifiedName", "referencedEntityVersion"]);

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
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(decorators)) {
    if (name && REFERENCE_KEYS.has(key)) continue;
    setOwn(out, key, decorators[key]);
  }
  if (name) setOwn(out, "referencedEntityName", name);
  return out;
}
