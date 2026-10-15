"use server";

import { getActiveTenantId } from "@/lib/active-tenant";
import { runMutation, sanitizeActionError } from "@/lib/action-context";
import type { ScopeTarget } from "@/lib/asset-scope";
import { createTrait, deleteTrait, updateTrait, type TraitInput } from "@/services/events/trait.service";
import type { TraitDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";

/**
 * A TENANT target is always the server-resolved active tenant (same rule as data types). The target comes from the
 * client, so a malformed one (null, wrong shape) is passed through untouched and the service rejects it.
 */
async function serverTarget(target: ScopeTarget): Promise<ScopeTarget> {
  const isTenant = typeof target === "object" && target !== null && target.level === "TENANT";
  return isTenant ? { level: "TENANT", tenantId: await getActiveTenantId() } : target;
}

/**
 * `runMutation` (session + `/schemas` layout revalidation on success) around a service call whose ownership check runs before any
 * write. `sanitizeActionError` also covers the tenant lookup above: raw database text never reaches the forms that render the result.
 */
export async function createTraitAction(target: ScopeTarget, input: TraitInput): Promise<ActionResult<TraitDetail>> {
  return runMutation((ctx) => sanitizeActionError((async () => createTrait(await serverTarget(target), input, ctx))(), "createTraitAction"));
}

export async function updateTraitAction(traitId: string, owner: ScopeTarget, input: Omit<TraitInput, "kind">): Promise<ActionResult<TraitDetail>> {
  return runMutation((ctx) => sanitizeActionError((async () => updateTrait(traitId, input, await serverTarget(owner), ctx))(), "updateTraitAction"));
}

export async function deleteTraitAction(traitId: string, owner: ScopeTarget): Promise<ActionResult<{ id: string }>> {
  return runMutation((ctx) => sanitizeActionError((async () => deleteTrait(traitId, await serverTarget(owner), ctx))(), "deleteTraitAction"));
}
