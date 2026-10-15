"use server";

import { getActiveTenantId } from "@/lib/active-tenant";
import { runMutation } from "@/lib/action-context";
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

export async function createTraitAction(target: ScopeTarget, input: TraitInput): Promise<ActionResult<TraitDetail>> {
  return runMutation(async (ctx) => createTrait(await serverTarget(target), input, ctx));
}

export async function updateTraitAction(traitId: string, owner: ScopeTarget, input: Omit<TraitInput, "kind">): Promise<ActionResult<TraitDetail>> {
  return runMutation(async (ctx) => updateTrait(traitId, input, await serverTarget(owner), ctx));
}

export async function deleteTraitAction(traitId: string, owner: ScopeTarget): Promise<ActionResult<{ id: string }>> {
  return runMutation(async (ctx) => deleteTrait(traitId, await serverTarget(owner), ctx));
}
