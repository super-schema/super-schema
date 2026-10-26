"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { contextOf, guardActiveTenant, guardTarget, sanitizeActionError, toActionResult, unexpectedFailure } from "@/lib/action-context";
import type { ScopeTarget } from "@/lib/asset-scope";
import { createTrait, deleteTrait, updateTrait, type TraitInput } from "@/services/events/trait.service";
import type { TraitDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

/**
 * The guard and the revalidation around one trait service call. The owner target is CLIENT-supplied below the tenant level (a domain /
 * product id) and the service only compares the row against it, so the policy is asked over the OWNER first (`trait.write`, an author's act
 * over the tenant, the domain or the product the trait lives in): a target of another tenant, one nothing of the caller's covers, a missing
 * one and a malformed one all answer the NOT_FOUND of an unknown domain / product / target and the service never runs; too low a role is a
 * generic refusal. A TENANT target is always the server-resolved active tenant (the client's tenant id is never read; same rule as data
 * types), judged at tenant level: a domain-scoped author cannot make a tenant-wide trait. `sanitizeActionError` keeps raw database text out
 * of the forms that render the result; the `/schemas` layout is revalidated on success only.
 */
async function runTraitAction<T>(
  label: string,
  target: ScopeTarget,
  run: (owner: ScopeTarget, ctx: ServiceContext) => Promise<Result<T>>
): Promise<ActionResult<T>> {
  try {
    const isTenant = typeof target === "object" && target !== null && target.level === "TENANT";
    const access = isTenant ? await guardActiveTenant("trait.write", { label: "Tenant" }) : await guardTarget("trait.write", target);
    if (!access.allowed) return { success: false, ...access.refusal };
    const owner: ScopeTarget = isTenant ? { level: "TENANT", tenantId: access.resource.tenantId } : target;
    const result = await sanitizeActionError(run(owner, contextOf(access.principal)), label);
    if (result.success) revalidatePath("/schemas", "layout");
    return toActionResult(result, label);
  } catch (e: unknown) {
    unstable_rethrow(e);
    return { success: false, ...unexpectedFailure(label, e) };
  }
}

export async function createTraitAction(target: ScopeTarget, input: TraitInput): Promise<ActionResult<TraitDetail>> {
  return runTraitAction("createTraitAction", target, (owner, ctx) => createTrait(owner, input, ctx));
}

export async function updateTraitAction(traitId: string, owner: ScopeTarget, input: Omit<TraitInput, "kind">): Promise<ActionResult<TraitDetail>> {
  return runTraitAction("updateTraitAction", owner, (target, ctx) => updateTrait(traitId, input, target, ctx));
}

export async function deleteTraitAction(traitId: string, owner: ScopeTarget): Promise<ActionResult<{ id: string }>> {
  return runTraitAction("deleteTraitAction", owner, (target, ctx) => deleteTrait(traitId, target, ctx));
}
