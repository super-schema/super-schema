"use server";

import { getActiveTenantId } from "@/lib/active-tenant";
import { getActionContext, NOT_AUTHENTICATED } from "@/lib/action-context";
import type { ActionResult } from "@/types/action-result";
import { loadPinnableVersions } from "./load-options";
import type { VersionOption } from "./shared/EntityPinPicker";

const NOT_FOUND = { success: false, error: "Entity not found", code: "NOT_FOUND" } as const satisfies ActionResult<never>;

/**
 * Published versions of an entity for the pin picker. Read-only (never revalidates). Unlike
 * `listEntityVersionsAction` — the entity workspace's own loader, which takes the entity id as given —
 * this one is scoped to the server-resolved active tenant: the client-supplied id must belong to it,
 * otherwise NOT_FOUND. Failures return a generic message; database error text never reaches the client.
 */
export async function listPinnableVersionsAction(entityId: string): Promise<ActionResult<VersionOption[]>> {
  try {
    const ctx = await getActionContext();
    if (!ctx) return NOT_AUTHENTICATED;
    const versions = await loadPinnableVersions(await getActiveTenantId(), entityId);
    return versions ? { success: true, data: versions } : NOT_FOUND;
  } catch (e) {
    console.error("listPinnableVersionsAction failed", e);
    return { success: false, error: "Could not load versions", code: "INTERNAL_ERROR" };
  }
}
