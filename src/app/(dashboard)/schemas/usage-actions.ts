"use server";

import { getActiveTenantId } from "@/lib/active-tenant";
import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import type { UsageList, UsageSubject } from "@/lib/events/usage";
import { findUsages } from "@/services/events/usage.service";
import type { ActionResult } from "@/types/action-result";
import { ok } from "@/types/result";

/**
 * Spec 18.9 "Who uses X?" — read-only: an authenticated session is enough (D16) and nothing is revalidated.
 * The tenant is the server-resolved active tenant, never a client value; the subject id is untrusted and the
 * service rejects a malformed one or one outside that tenant.
 *
 * The answer is `{ rows, truncated }`: `findUsages` returns an array carrying `truncated` as a non-index property, which the
 * action serializer drops, so the flag is copied into the object that is sent.
 */
export async function listUsagesAction(subject: UsageSubject): Promise<ActionResult<UsageList>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  const result = await findUsages(subject, ctx, await getActiveTenantId());
  // A DB_ERROR message is driver text (hosts, constraint names); the browser only gets a generic one.
  if (!result.success && result.error.code === "DB_ERROR") {
    return { success: false, error: "Could not load usages. Try again.", code: "DB_ERROR" };
  }
  return toActionResult(result.success ? ok({ rows: [...result.data], truncated: result.data.truncated === true }) : result);
}
