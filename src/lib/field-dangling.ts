import { REFERENCE_DECORATOR_KEYS, holdsEntityReference, referenceTargetKey, withoutReferenceKeys } from "@/lib/references/entity-reference";

/**
 * Dangling-reference marker of a field (`decorators.danglingRef`, pure).
 *
 * An import keeps an external `$ref` that is defined nowhere as `{ ref, element? }` on the field's decorators. The marker is only
 * true while the field still IS that reference: a direct reference (`type: reference`, no `element`) or an array of references
 * (`type: array`, `element: true`, `arrayElementType: reference`). Everything that reads it goes through `activeDanglingRef`, so a stale
 * marker (the user changed the field's type or target afterwards) can never keep a field "unresolved"; the edit paths also clear it
 * (`decoratorsAfterFieldEdit`).
 */

export interface DanglingMarker {
  ref: string;
  element?: true;
}

/** The marker stored in `decorators`, shape-checked (it comes from stored JSON); undefined when there is none. */
export function readDanglingMarker(decorators: unknown): DanglingMarker | undefined {
  const value = decorators && typeof decorators === "object" ? (decorators as { danglingRef?: unknown }).danglingRef : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { ref, element } = value as { ref?: unknown; element?: unknown };
  if (typeof ref !== "string" || ref === "") return undefined;
  return { ref, ...(element === true ? { element: true as const } : {}) };
}

/**
 * The marker of a field of `type` when the field is still the unresolved reference it records, else undefined. `type` undefined
 * (a caller that does not know it) skips the type check. `decorators` may be the stored decorators or any object with `danglingRef`
 * (+ `arrayElementType` for an array).
 */
export function activeDanglingRef(
  type: string | undefined,
  decorators: { danglingRef?: unknown; arrayElementType?: unknown } | null | undefined,
): DanglingMarker | undefined {
  const marker = readDanglingMarker(decorators);
  if (!marker) return undefined;
  if (type === undefined) return marker;
  if (type === "reference") return marker.element ? undefined : marker;
  if (type === "array") return marker.element && decorators?.arrayElementType === "reference" ? marker : undefined;
  return undefined;
}

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The decorators to write for a field edit. `next` is what the client sends (undefined: decorators untouched); returns undefined when
 * nothing needs writing. Never touches a key the rules below do not name:
 * - The dangling marker is cleared when the edit resolves it: the field is no longer the reference it records (type changed away, or the
 *   reference target / array element type changed).
 * - A field that is no longer a reference (`holdsEntityReference`: retyped away from `reference`, an array whose elements or a map whose
 *   values stopped being references) loses its `referenced*` keys: the target, its id and its pin. Left behind they would keep the old
 *   target in the closure and an invisible pin could fail a publish. Judged by what the field is AFTER the edit, so an array of
 *   references keeps them.
 * - A reference whose TARGET changed loses the pin of the old one when the edit carries it along unchanged; a pin the edit itself sets
 *   is kept. (The target is the entity id, or the name of a name-only reference.)
 */
export function decoratorsAfterFieldEdit(
  existing: { type: string; decorators: unknown },
  edit: { type?: string; decorators?: Record<string, unknown> },
): Record<string, unknown> | undefined {
  const current = (existing.decorators && typeof existing.decorators === "object" && !Array.isArray(existing.decorators)
    ? (existing.decorators as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const type = edit.type ?? existing.type;

  const next = clearedDanglingMarker(current, type, edit);
  const after = next ?? current;

  if (!holdsEntityReference(type, after)) {
    return REFERENCE_DECORATOR_KEYS.some((key) => hasOwn(after, key)) ? withoutReferenceKeys(after) : next;
  }

  if (next !== undefined && hasOwn(next, "referencedEntityVersion")) {
    const was = referenceTargetKey(current);
    const now = referenceTargetKey(next);
    if (was !== undefined && now !== was && next.referencedEntityVersion === current.referencedEntityVersion) {
      return withoutPin(next);
    }
  }
  return next;
}

function withoutPin(decorators: Record<string, unknown>): Record<string, unknown> {
  const { referencedEntityVersion: _pin, ...rest } = decorators;
  void _pin;
  return rest;
}

/** The dangling-marker rule of `decoratorsAfterFieldEdit`: the decorators with the marker cleared, or `edit.decorators` as it is. */
function clearedDanglingMarker(
  current: Record<string, unknown>,
  type: string,
  edit: { decorators?: Record<string, unknown> },
): Record<string, unknown> | undefined {
  const effective = edit.decorators ?? current;
  if (readDanglingMarker(effective) === undefined) return edit.decorators;

  // Changed only when the edit states a different value (a partial decorators object that omits a key does not change it).
  const differs = (key: string) => key in effective && effective[key] !== current[key];
  const targetChanged = differs("referencedEntityName") || differs("arrayElementType");
  const stillDangling = activeDanglingRef(type, effective) !== undefined && !targetChanged;
  if (stillDangling) return edit.decorators;

  const { danglingRef: _removed, ...rest } = effective;
  void _removed;
  return rest;
}
