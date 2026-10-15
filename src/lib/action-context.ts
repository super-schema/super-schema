// src/lib/action-context.ts
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { auth } from "@/lib/auth";
import { AuditUserMissingError } from "@/lib/audit";
import { getActiveTenantId } from "@/lib/active-tenant";
import { resolveCurrentUserId } from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { getEffectiveRole } from "@/services/rbac.service";
import { GENERIC_ACTION_ERROR, isOpaqueErrorCode, type ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export const NOT_AUTHENTICATED = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" } as const satisfies ActionResult<never>;

/**
 * Same user + role resolution as the data-type / API actions: the session user is mapped to a `User` row
 * by id, then by email (`resolveCurrentUserId`), and the effective role fails closed to VIEWER (D16).
 * Returns null when there is no session or the session points at a user that no longer exists
 * (a stale session is treated as not authenticated — the caller signs in again).
 */
export async function getActionContext(): Promise<ServiceContext | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  let userId: string;
  try {
    userId = await resolveCurrentUserId(session.user);
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) return null;
    throw e;
  }
  const role = await getEffectiveRole(userId, null, { userId, userRole: "VIEWER", prisma });
  return { userId, userRole: role.success && role.data ? role.data : "VIEWER", prisma };
}

/**
 * Soft-grouping scope guard for rows addressed by a bare id (the older data-type / API / model-field / entity-field actions
 * take no owner target): the row must belong to the caller's ACTIVE tenant, the same scoping the pages and the Events
 * actions use. A row of another tenant reads exactly like a missing one (callers answer NOT_FOUND, never FORBIDDEN), so an
 * id guessed from another tenant reveals nothing.
 */
export async function isInActiveTenant(rowTenantId: string | null | undefined): Promise<boolean> {
  return typeof rowTenantId === "string" && rowTenantId === (await getActiveTenantId());
}

/**
 * The ONE place a service failure is made safe for the browser (`toActionResult` and `sanitizeActionError` both call it).
 * `DB_ERROR` / `INTERNAL_ERROR` messages may carry raw database / driver / parser text (hosts, constraint and column names),
 * so such a failure is logged server-side (`label`, which of the two it is, the original message) and replaced by the generic
 * message: no `details`, no `suggestedFix`. Idempotent: a failure that is already exactly the generic one (sanitized at the
 * source by `dbErrorResult`, or by a per-action `sanitizeActionError`) is returned as is and not logged a second time.
 * Every other failure and every success is returned as the very same object.
 */
function sanitizeResult<T>(result: Result<T>, label: string): Result<T> {
  if (result.success || !isOpaqueErrorCode(result.error.code)) return result;
  const { code, message, details, suggestedFix } = result.error;
  if (message === GENERIC_ACTION_ERROR && !details && !suggestedFix) return result;
  console.error(`[${label}] ${code === "DB_ERROR" ? "database error" : "internal error"}`, message);
  return { success: false, error: { code, message: GENERIC_ACTION_ERROR } };
}

/**
 * Service Result -> server action result, safe to send over the wire: opaque failures (`DB_ERROR`, `INTERNAL_ERROR`) are
 * sanitized (see `sanitizeResult`); everything else passes through with its message, `details` and `suggestedFix`.
 * `label` names the action in the server-side log of a sanitized failure.
 */
export function toActionResult<T>(result: Result<T>, label = "action"): ActionResult<T> {
  const safe = sanitizeResult(result, label);
  if (safe.success) return { success: true, data: safe.data };
  const { message, code, details, suggestedFix } = safe.error;
  return {
    success: false,
    error: message,
    code,
    ...(details && { details }),
    ...(suggestedFix && { suggestedFix }),
  };
}

/**
 * The shared shape of every mutating events server action: authenticate, run the service call, and
 * revalidate `/schemas` (layout) on success only (`staleTimes.dynamic = 30` would otherwise serve stale pages).
 * Read-only actions use `getActionContext` + `toActionResult` directly and never revalidate. A failed Result goes through
 * `toActionResult`, so a `DB_ERROR` / `INTERNAL_ERROR` never reaches the browser with its raw text (`label` names the action
 * in the server-side log of that failure).
 *
 * An unexpected REJECTION from the session lookup or from `run` (a driver / Prisma validation error from a service that
 * lets malformed client input reach a query, a lost connection) is caught here as well: it is logged server-side and
 * returned as a generic `INTERNAL_ERROR` instead of an unhandled 500 carrying the raw text. Next's own control-flow throws
 * (`redirect()`, `notFound()`, `forbidden()`, `unauthorized()`, dynamic-rendering bailouts) are NOT failures: they are
 * re-thrown untouched through `unstable_rethrow`, which owns the list of such errors (digest `NEXT_REDIRECT`,
 * `NEXT_HTTP_ERROR_FALLBACK;…`, …), so the framework still sees them. Revalidation sits outside the try: a write that
 * has already committed is never reported as a failure.
 */
export async function runMutation<T>(run: (ctx: ServiceContext) => Promise<Result<T>>, label = "mutation"): Promise<ActionResult<T>> {
  let result: Result<T>;
  try {
    const ctx = await getActionContext();
    if (!ctx) return NOT_AUTHENTICATED;
    result = await run(ctx);
  } catch (e: unknown) {
    unstable_rethrow(e);
    console.error(`[${label}] unexpected error`, e);
    return { success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" };
  }
  if (result.success) revalidatePath("/schemas", "layout");
  return toActionResult(result, label);
}

/** Defined in the client-safe `@/types/action-result` (forms use it too); re-exported for existing server-side callers. */
export { GENERIC_ACTION_ERROR };

/**
 * Keeps raw database / driver text out of the browser for actions whose services can surface it: pass a service Result (or the
 * promise of one). An opaque failure (`DB_ERROR` / `INTERNAL_ERROR`) becomes the generic message (same implementation as
 * `toActionResult`) and a rejection becomes a generic `INTERNAL_ERROR`; the original is logged server-side with `label`.
 * Every other failure (planner codes, blockers in `details`, `suggestedFix`, CONFLICT, NOT_FOUND, FORBIDDEN…) and every
 * success passes through untouched. Lives here, not in a "use server" module.
 */
export async function sanitizeActionError<T>(result: Result<T> | Promise<Result<T>>, label = "action"): Promise<Result<T>> {
  try {
    return sanitizeResult(await result, label);
  } catch (e: unknown) {
    console.error(`[${label}] unexpected error`, e);
    return { success: false, error: { code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR } };
  }
}
