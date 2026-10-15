// src/lib/action-context.ts
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { auth } from "@/lib/auth";
import { AuditUserMissingError } from "@/lib/audit";
import { getActiveTenantId } from "@/lib/active-tenant";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import { parseScopeTarget } from "@/services/events/service-guards";
import { resolveCurrentUserId } from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { getEffectiveRole } from "@/services/rbac.service";
import { GENERIC_ACTION_ERROR, isOpaqueErrorCode, type ActionResult } from "@/types/action-result";
import { err, ok, type Result, type ServiceError } from "@/types/result";
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

/** Reads the tenant a by-id row belongs to (its own `tenantId`, or the one of the parent it hangs under); null / undefined = no such row. */
const TENANT_OF = {
  entity: async (id: string) => (await prisma.entity.findUnique({ where: { id }, select: { tenantId: true } }))?.tenantId,
  field: async (id: string) => (await prisma.field.findUnique({ where: { id }, select: { entity: { select: { tenantId: true } } } }))?.entity.tenantId,
  domain: async (id: string) => (await prisma.domain.findUnique({ where: { id }, select: { tenantId: true } }))?.tenantId,
  product: async (id: string) => (await prisma.product.findUnique({ where: { id }, select: { domain: { select: { tenantId: true } } } }))?.domain.tenantId,
  model: async (id: string) => (await prisma.modelDefinition.findUnique({ where: { id }, select: { domain: { select: { tenantId: true } } } }))?.domain.tenantId,
  modelField: async (id: string) =>
    (await prisma.modelFieldDefinition.findUnique({ where: { id }, select: { model: { select: { domain: { select: { tenantId: true } } } } } }))?.model.domain.tenantId,
  sharedEnum: async (id: string) => (await prisma.sharedEnum.findUnique({ where: { id }, select: { tenantId: true } }))?.tenantId,
  customScalar: async (id: string) => (await prisma.customScalar.findUnique({ where: { id }, select: { tenantId: true } }))?.tenantId,
  unionType: async (id: string) => (await prisma.unionType.findUnique({ where: { id }, select: { tenantId: true } }))?.tenantId,
  service: async (id: string) => (await prisma.serviceDefinition.findUnique({ where: { id }, select: { tenantId: true } }))?.tenantId,
  operation: async (id: string) => (await prisma.operation.findUnique({ where: { id }, select: { service: { select: { tenantId: true } } } }))?.service.tenantId,
} as const;

/** The kinds of by-id row `inActiveTenant` can check (one per model the older actions address by a bare id). */
export type TenantScopedKind = keyof typeof TENANT_OF;

/**
 * The by-id ownership guard of the older entity / model / API / data-type / product actions: true only when the row `id` names
 * exists AND (itself, or through its parent: field -> entity, model field -> model -> domain, operation -> service,
 * product -> domain) belongs to the caller's ACTIVE tenant (`isInActiveTenant`). A malformed id, a missing row and a row of
 * another tenant are all `false`, so a caller answers the three with the one identical NOT_FOUND and an id guessed from
 * another tenant reveals nothing. Create-style actions pass their PARENT id (an entity for a field, a model for a model
 * field, a service for an operation, a domain for a product). Call it before any read of or write to the row.
 */
export async function inActiveTenant(kind: TenantScopedKind, id: unknown): Promise<boolean> {
  if (typeof id !== "string" || id.trim() === "") return false;
  return isInActiveTenant(await TENANT_OF[kind](id));
}

/** The id a scope target names and the label `resolveScope` uses for it. */
function targetId(target: ScopeTarget): { label: string; id: unknown } {
  return target.level === "TENANT"
    ? { label: "Tenant", id: target.tenantId }
    : target.level === "DOMAIN"
      ? { label: "Domain", id: target.domainId }
      : { label: "Product", id: target.productId };
}

/**
 * What `resolveScope` answers for a target that does not exist: a target of another tenant must read exactly like it. A
 * non-string id (never a real one) is not echoed.
 */
const missingTargetMessage = (target: ScopeTarget) => {
  const { label, id } = targetId(target);
  return `${label} "${typeof id === "string" ? id : ""}" not found`;
};

/**
 * `inActiveTenant` for a create's `ScopeTarget` (a domain or product id taken from the client): resolves the target and
 * answers the very NOT_FOUND `resolveScope` gives a missing one when it belongs to another tenant. A malformed target (not an
 * object, a non-string or blank id) is NOT_FOUND too, WITHOUT a query: it can never reach a Prisma validator and come back as
 * its message. Success carries nothing: the write that follows re-resolves the target itself.
 */
export async function targetInActiveTenant(target: ScopeTarget): Promise<Result<undefined>> {
  if (typeof target !== "object" || target === null) return err({ code: "NOT_FOUND", message: "Target not found" });
  const { id } = targetId(target);
  if (typeof id !== "string" || id.trim() === "") return err({ code: "NOT_FOUND", message: missingTargetMessage(target) });
  const scope = await resolveScope(prisma, target);
  if (!scope.success) return scope;
  if (!(await isInActiveTenant(scope.data.tenantId))) return err({ code: "NOT_FOUND", message: missingTargetMessage(target) });
  return ok(undefined);
}

/**
 * The PARENT check of the Events actions (channels, messages, event specs, traits and their publish / preview / list actions):
 * they take a CLIENT-supplied product (or owner target) and the services only compare the row against that owner, so an owner
 * of another tenant would be self-consistent. A well-formed `target` must lie in the ACTIVE tenant, else its failure is exactly
 * the NOT_FOUND `resolveScope` gives an unknown one and `run` (the service call) never starts. A malformed target skips the
 * check on purpose: the service parses it with the same `parseScopeTarget` and answers its own VALIDATION_ERROR, so no write is
 * reachable and that answer stays unchanged. The service-level `assertOwnedBy` stays behind this check.
 */
export async function withOwnedTarget<T>(target: unknown, run: () => Promise<Result<T>>): Promise<Result<T>> {
  const parsed = parseScopeTarget(target);
  if (parsed.success) {
    const owned = await targetInActiveTenant(parsed.data);
    if (!owned.success) return owned;
  }
  return run();
}

/** The wire shape of the older (non-Result) by-id actions' not-found answer; a foreign row and a missing one are both exactly this. */
export const notFoundFailure = (kind: string) => ({ error: `${kind} not found`, code: "NOT_FOUND" as const });

const STALE_SESSION_ERROR = "Your session is stale. Sign out and sign in again, then retry.";

/**
 * An unexpected throw in an older (non-Result) action: Next's control-flow errors (`redirect()`, `notFound()`, ...) are re-thrown
 * through `unstable_rethrow` first; a stale session (`AuditUserMissingError`: the session's user no longer exists) is answered
 * with its one actionable line; everything else is logged server-side (`label` + the original) and answered with the generic
 * message: raw driver / Prisma / TypeError text (paths, source excerpts, column names) never reaches the browser.
 */
export function unexpectedFailure(label: string, e: unknown) {
  unstable_rethrow(e);
  if (e instanceof AuditUserMissingError) return { error: STALE_SESSION_ERROR, code: "UNAUTHORIZED" as const };
  console.error(`[${label}] unexpected error`, e);
  return { error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" as const };
}

/**
 * A failed service Result in an older (non-Result) action's wire shape: the service's message and code, except the opaque
 * codes (`DB_ERROR` / `INTERNAL_ERROR`), whose message may carry raw database text: those are logged and replaced by the
 * generic one. Same decision as `sanitizeResult`, for actions that return `{ error, code }`.
 */
export function failureOf(error: ServiceError, label: string) {
  if (!isOpaqueErrorCode(error.code)) return { error: error.message, code: error.code };
  console.error(`[${label}] ${error.code === "DB_ERROR" ? "database error" : "internal error"}`, error.message);
  return { error: GENERIC_ACTION_ERROR, code: error.code };
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
