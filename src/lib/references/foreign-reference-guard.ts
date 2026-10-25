/**
 * Store-time check for the entity id a field's decorators point at (`decorators.referencedEntityId`).
 *
 * The field actions and services keep the decorators a client sends as they are. The id inside is what publish pins, what the closure and the
 * payload renderers load, so an id of ANOTHER tenant's entity stored here would make this tenant read that entity's name, source and fields.
 * A new or changed id must therefore name an entity the caller's tenant owns; an id the field already holds is left alone (the entity it names
 * may have been deleted since, and an unrelated edit of that field must stay possible). The readers are tenant-scoped as well, so what was
 * stored before this check cannot be read through either.
 *
 * Pure apart from the `isAllowed` callback (the tenant lookup), which the caller supplies: the actions ask the ACTIVE tenant
 * (`inActiveTenant`), the services compare with the tenant of the entity that owns the field.
 */

/** What a refused id is answered with: the same for a foreign entity and for one that does not exist. */
export const FOREIGN_REFERENCE_MESSAGE = "The referenced entity could not be found";

function ownReferencedId(decorators: unknown): string | undefined {
  if (!decorators || typeof decorators !== "object" || Array.isArray(decorators)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(decorators, "referencedEntityId")) return undefined;
  const value = (decorators as Record<string, unknown>).referencedEntityId;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The entity id `next` names that `previous` does not already hold (undefined: none, or the same one as before). */
export function newReferencedEntityId(next: unknown, previous: unknown): string | undefined {
  const id = ownReferencedId(next);
  return id !== undefined && id !== ownReferencedId(previous) ? id : undefined;
}

/**
 * True when no field of a create (an entity created with its fields: the wizard, an import) names an entity id that fails `isAllowed`.
 * A create has nothing stored yet, so every id counts as new. Not a list, or an entry that is not an object: nothing to check (the create's
 * own validation answers those).
 */
export async function fieldsReferenceAllowed(
  fields: unknown,
  isAllowed: (entityId: string) => Promise<boolean>
): Promise<boolean> {
  if (!Array.isArray(fields)) return true;
  const ids = new Set<string>();
  for (const field of fields) {
    const id = newReferencedEntityId(field && typeof field === "object" ? (field as { decorators?: unknown }).decorators : undefined, undefined);
    if (id !== undefined) ids.add(id);
  }
  for (const id of ids) if (!(await isAllowed(id))) return false;
  return true;
}

/** True when the decorators name no new entity id, or the new one passes `isAllowed`. */
export async function referencedEntityAllowed(
  next: unknown,
  previous: unknown,
  isAllowed: (entityId: string) => Promise<boolean>
): Promise<boolean> {
  const id = newReferencedEntityId(next, previous);
  return id === undefined || (await isAllowed(id));
}
