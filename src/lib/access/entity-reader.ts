/**
 * Who may read an entity, as the question the reference closure asks (KD-045): `entity.read` over the entity's own place, decided by the
 * policy from the caller's assignments. A closure that reaches an entity the caller's roles do not cover is refused (see
 * `loadReferenceClosure`'s `reader`), so an emission, a validation, a preview or a publish of an entity the caller may read never carries the
 * content of one they may not.
 *
 * Pure. A missing list of assignments reads nothing (never everything), like `ctxCan`; a malformed place reads as unreadable.
 */

import type { Assignment, ResourceRef } from "./scope";
import { can } from "./policy";

/** Where an entity sits: its tenant, and the domain and product it hangs under (none for a tenant-level entity). */
export type EntityPlace = { tenantId: string; domainId: string | null; productId: string | null };

/** The reader for a caller who holds `assignments`: `(place) => may they read the entity there?` */
export function entityReader(assignments: readonly Assignment[] | undefined): (place: EntityPlace) => boolean {
  const held = [...(assignments ?? [])];
  return (place) => {
    if (typeof place !== "object" || place === null) return false;
    const resource: ResourceRef = { tenantId: place.tenantId, domainId: place.domainId ?? null, productId: place.productId ?? null };
    return can(held, "entity.read", resource);
  };
}
