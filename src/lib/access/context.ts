/**
 * The policy asked from inside a service: may the caller whose context is `ctx` perform `action` on `resource`? The services that still decide
 * for themselves (as a second gate behind the action's guard) ask this instead of comparing a role name: it is `can` over the assignments the
 * context carries (`contextOf(principal)`), and a context that carries none (an older caller, a test) allows nothing, never everything.
 *
 * Pure, no I/O. For a PLATFORM action (`platform.admin`, `emitter.manage`, `git.manage`, `classification.manage`, `ai.manage`) the resource is ignored and only
 * a GLOBAL administrator passes; give the resource for anything judged over a place.
 */

import type { ServiceContext } from "@/types/service-context";
import type { ActionId } from "./actions";
import { can } from "./policy";
import type { ResourceRef } from "./scope";

/** The tenant a platform decision is "judged over": no tenant has this id, so nothing but a GLOBAL assignment can cover it. */
const NO_PLACE: ResourceRef = { tenantId: "-" };

export function ctxCan(ctx: Pick<ServiceContext, "assignments">, action: ActionId, resource: ResourceRef = NO_PLACE): boolean {
  return can([...(ctx.assignments ?? [])], action, resource);
}
