"use server";

import { NOT_AUTHENTICATED, guardSubject } from "@/lib/action-context";
import type { ActionResult } from "@/types/action-result";
import { loadPinnableVersions } from "./load-options";
import type { VersionOption } from "./shared/EntityPinPicker";

const NOT_FOUND = { success: false, error: "Entity not found", code: "NOT_FOUND" } as const satisfies ActionResult<never>;

/**
 * Published versions of an entity for the pin picker. Read-only (never revalidates). Unlike
 * `listEntityVersionsAction` — the entity workspace's own loader — this one is judged as what it is for: pinning a schema into an event
 * (`event.pin`, an author or more) over the ENTITY'S place, so the client-supplied id must be an entity of the ACTIVE tenant that the caller's
 * roles cover; a missing entity, one of another tenant and one the caller cannot see are all the same NOT_FOUND, and a viewer is refused.
 * Failures return a generic message; database error text never reaches the client.
 */
export async function listPinnableVersionsAction(entityId: string): Promise<ActionResult<VersionOption[]>> {
  try {
    const access = await guardSubject("event.pin", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) {
      if (access.refusal.code === "NOT_FOUND") return NOT_FOUND;
      if (access.refusal.code === "FORBIDDEN") return { success: false, error: access.refusal.error, code: "FORBIDDEN" };
      return NOT_AUTHENTICATED;
    }
    const versions = await loadPinnableVersions(access.resource.tenantId, entityId);
    return versions ? { success: true, data: versions } : NOT_FOUND;
  } catch (e) {
    console.error("listPinnableVersionsAction failed", e);
    return { success: false, error: "Could not load versions", code: "INTERNAL_ERROR" };
  }
}
