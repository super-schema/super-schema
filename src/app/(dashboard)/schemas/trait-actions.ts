"use server";

import { getActiveTenantId } from "@/lib/active-tenant";
import { runMutation, sanitizeActionError, withOwnedTarget } from "@/lib/action-context";
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
 * write. The owner target is CLIENT-supplied below the tenant level (a domain / product id) and the service only compares the row
 * against it, so `withOwnedTarget` first requires a well-formed target to lie in the ACTIVE tenant (a foreign one is the
 * NOT_FOUND of an unknown domain / product and the service never runs; a malformed target is left to the service's own
 * VALIDATION_ERROR). `sanitizeActionError` also covers the tenant lookup above: raw database text never reaches the forms that
 * render the result.
 */
export async function createTraitAction(target: ScopeTarget, input: TraitInput): Promise<ActionResult<TraitDetail>> {
  return runMutation((ctx) => sanitizeActionError((async () => { const owner = await serverTarget(target); return withOwnedTarget(owner, async () => createTrait(owner, input, ctx)); })(), "createTraitAction")); // TODO(access-control task 5): runMutation without an action: pass { action, resource } as the first argument
}

export async function updateTraitAction(traitId: string, owner: ScopeTarget, input: Omit<TraitInput, "kind">): Promise<ActionResult<TraitDetail>> {
  return runMutation((ctx) => sanitizeActionError((async () => { const target = await serverTarget(owner); return withOwnedTarget(target, async () => updateTrait(traitId, input, target, ctx)); })(), "updateTraitAction")); // TODO(access-control task 5): runMutation without an action: pass { action, resource } as the first argument
}

export async function deleteTraitAction(traitId: string, owner: ScopeTarget): Promise<ActionResult<{ id: string }>> {
  return runMutation((ctx) => sanitizeActionError((async () => { const target = await serverTarget(owner); return withOwnedTarget(target, async () => deleteTrait(traitId, target, ctx)); })(), "deleteTraitAction")); // TODO(access-control task 5): runMutation without an action: pass { action, resource } as the first argument
}
