// src/lib/action-context.ts
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { auth } from "@/lib/auth";
import { AuditUserMissingError } from "@/lib/audit";
import { getActiveTenantId } from "@/lib/active-tenant";
import { ACTIONS, can, contextRole, effectiveRole, isActionId, type ActionId, type ResourceRef } from "@/lib/access";
import { isNoTenantAccess } from "@/lib/access/no-tenant-access";
import { getPrincipal, type Principal } from "@/lib/access/principal";
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
 * The LEGACY service context (the older data-type / API / events actions): the session user id is mapped to a `User` row by id ALONE
 * (`resolveCurrentUserId`: no e-mail fallback; a missing or disabled user throws `AuditUserMissingError`) and `userRole` is the role the
 * user holds at global scope, failing closed to the lowest rung. Returns null when there is no session or the session points at nobody
 * (a stale session is treated as not authenticated: the caller signs in again). New code asks `authorize` instead and builds its context
 * from the principal it returns (`contextOf`); this stays for the callers Task 5 has not migrated yet.
 */
export async function getActionContext(): Promise<ServiceContext | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  let userId: string;
  try {
    userId = await resolveCurrentUserId({ id: session.user.id });
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) return null;
    throw e;
  }
  const role = await getEffectiveRole(userId, null, { userId, userRole: contextRole([]), prisma });
  return { userId, userRole: role.success && role.data ? role.data : contextRole([]), prisma };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// authorize: the one decision every guarded call asks (access-control design, goal 3)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The answer for a resource the caller cannot see: exactly this for a missing row and for a row of a tenant (or a domain, or a product)
 * the principal holds no role in, so a foreign resource is indistinguishable from a missing one. A caller whose wire shape differs (the
 * `Domain "x" not found` of `resolveScope`, an `Entity not found`) passes its own to `authorizeSubject` and gets IT for both cases.
 */
export const NOT_FOUND_MESSAGE = "Not found";
export function notFoundError(): ServiceError {
  return { code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
}

/** The refusal of a principal who can see the resource but holds too low a role: one generic text, naming no role, action or resource. */
const forbiddenError = (): ServiceError => ({ code: "FORBIDDEN", message: "You do not have permission to do this" });
const unauthorizedError = (): ServiceError => ({ code: "UNAUTHORIZED", message: "Not authenticated" });

/**
 * THE decision, pure and synchronous: may `principal` perform `action` on `resource`?
 *
 * - no principal (nobody signed in, a disabled user, a stale session): UNAUTHORIZED;
 * - an action id that is not in the table: FORBIDDEN (it is a bug; it must never be allowed);
 * - `self` actions (own notifications and profile): any principal passes, role or not;
 * - `global` (platform) actions: only a GLOBAL ADMIN; anyone else is FORBIDDEN (there is no resource to hide);
 * - every other action is judged against the resource. A principal who CANNOT SEE the resource gets `notFound` (NOT_FOUND, the very
 *   answer for a missing resource): for a resource-level action that is "no role of theirs covers the resource" (another tenant, a
 *   sibling domain, a tenant-level entity for a domain role), for a tenant-wide action "holds no role in the tenant". One who can see it
 *   but holds too low a role gets FORBIDDEN, with a message that says nothing else.
 */
export function authorizePrincipal(
  principal: Principal | null,
  action: ActionId,
  resource: ResourceRef,
  notFound: ServiceError = notFoundError()
): Result<Principal, ServiceError> {
  if (!principal) return { success: false, error: unauthorizedError() };
  if (!isActionId(action)) return { success: false, error: forbiddenError() };

  const spec = ACTIONS[action];
  if (spec.level === "self") return ok(principal);
  if (spec.level === "global") return can(principal.assignments, action, resource) ? ok(principal) : { success: false, error: forbiddenError() };

  const visible = spec.level === "resource" ? effectiveRole(principal.assignments, resource) !== null : can(principal.assignments, "tenant.access", resource);
  if (!visible) return { success: false, error: { ...notFound } };
  return can(principal.assignments, action, resource) ? ok(principal) : { success: false, error: forbiddenError() };
}

/**
 * May the current principal perform `action` on `resource`? The principal comes back on success, so the caller can build its context from it.
 *
 * This is the decision ALONE: it does not look at which tenant is in view. It is for what is not about the content of the active tenant
 * (switching to a tenant, listing the tenants the user may reach). A guard in front of content, reading or writing, is
 * `authorizeInActiveTenant`: the resource must lie in the active tenant too.
 */
export async function authorize(action: ActionId, resource: ResourceRef): Promise<Result<Principal, ServiceError>> {
  return authorizePrincipal(await getPrincipal(), action, resource);
}

/** `authorize` for a decision about a tenant as a whole (create a domain, manage users, switch to it). */
export async function authorizeTenant(action: ActionId, tenantId: string): Promise<Result<Principal, ServiceError>> {
  return authorize(action, { tenantId });
}

/** The levels whose decision is not about a place: platform items and the user's own things have no resource (and so no tenant) to hide. */
const isPlaceless = (action: ActionId): boolean => ACTIONS[action].level === "self" || ACTIONS[action].level === "global";

/**
 * The tenant the principal is looking at, or null when they may reach none (`NoTenantAccess`: no role anywhere, a stale session). Any other
 * failure (the database) propagates: it is never turned into an answer about the resource.
 */
async function activeTenantOf(principal: Principal): Promise<string | null> {
  try {
    return await getActiveTenantId(principal);
  } catch (e: unknown) {
    if (isNoTenantAccess(e)) return null;
    throw e;
  }
}

/**
 * THE decision for content, pure once the active tenant is known: `authorizePrincipal` PLUS "the resource lies in the ACTIVE tenant". A
 * resource of another tenant is answered `notFound`, exactly as a missing one, even for a user who holds a covering role there (a user with
 * roles in tenants A and B and A in view cannot read or write B's rows by id; the tenant switch is how they get there) and even for a
 * global administrator. Platform and own-things actions are not about a place and skip the tenant test.
 */
function decideInActiveTenant(
  principal: Principal,
  activeTenantId: string | null,
  action: ActionId,
  resource: ResourceRef,
  notFound: ServiceError
): Result<Principal, ServiceError> {
  if (!isActionId(action)) return { success: false, error: forbiddenError() };
  if (!isPlaceless(action) && (activeTenantId === null || resource?.tenantId !== activeTenantId)) return { success: false, error: { ...notFound } };
  return authorizePrincipal(principal, action, resource, notFound);
}

/**
 * The shared body of every guard of content: who (nobody: UNAUTHORIZED), which tenant is in view, WHERE the resource is (`load`), then the
 * decision. The reads happen in this order whatever the outcome, so a foreign row and a missing one cost the same (no timing oracle on top of
 * the identical answer): the principal once, the active tenant once (unless the action has no place), the resource once. A `load` that
 * fails with NOT_FOUND answers `notFound`; any other failure of it is carried.
 */
async function authorizeLoaded(
  action: ActionId,
  load: () => Promise<Result<ResourceRef, ServiceError>>,
  notFound: ServiceError
): Promise<Result<{ principal: Principal; resource: ResourceRef }, ServiceError>> {
  const principal = await getPrincipal();
  if (!principal) return { success: false, error: unauthorizedError() };
  const activeTenantId = isActionId(action) && !isPlaceless(action) ? await activeTenantOf(principal) : null;
  const loaded = await load();
  if (!loaded.success) return { success: false, error: loaded.error.code === "NOT_FOUND" ? { ...notFound } : loaded.error };
  const decided = decideInActiveTenant(principal, activeTenantId, action, loaded.data, notFound);
  return decided.success ? ok({ principal, resource: loaded.data }) : decided;
}

/**
 * THE guard in front of content (access-control design, goal 3), for a resource whose place the caller already holds (a `ResourceRef` built
 * from a row it has read, or the target of a create): an action needs BOTH the resource in the ACTIVE tenant (else the same NOT_FOUND as a
 * missing resource) AND a role that covers it and reaches the action's minimum (else FORBIDDEN, generic). `notFound` is the caller's wire
 * shape for the refusal to see (default `notFoundError()`); it is the answer for the missing row and the unseen one alike.
 *
 * Never build the reference from client input (a `domainId` argument): take it from `resolveResourceRef` / `authorizeSubject`, which read
 * it from the row. Call it before any read of or write to the resource.
 */
export async function authorizeInActiveTenant(
  action: ActionId,
  resource: ResourceRef,
  notFound: ServiceError = notFoundError()
): Promise<Result<Principal, ServiceError>> {
  const decided = await authorizeLoaded(action, async () => ok(resource), notFound);
  return decided.success ? ok(decided.data.principal) : decided;
}

/** `authorizeInActiveTenant` for a decision about the ACTIVE tenant as a whole (list its domains, create a domain, the glossary). */
export async function authorizeActiveTenant(action: ActionId, notFound: ServiceError = notFoundError()): Promise<Result<Principal, ServiceError>> {
  const principal = await getPrincipal();
  if (!principal) return { success: false, error: unauthorizedError() };
  if (isActionId(action) && isPlaceless(action)) return authorizePrincipal(principal, action, { tenantId: "-" }, notFound);
  const activeTenantId = await activeTenantOf(principal);
  return decideInActiveTenant(principal, activeTenantId, action, { tenantId: activeTenantId ?? "-" }, notFound);
}

/**
 * Where a stored row lives, from the row itself: one `findUnique` per kind with the tenant, domain and product it hangs under (itself, or
 * through its parent: field -> entity, model field -> model, operation -> service, product -> domain). It generalises the by-id ownership
 * map of the older actions: those only needed the tenant, authorization needs the whole chain (a domain-scoped role is judged against the
 * row's domain, a product-scoped one against its product).
 */
const OWNER = { tenantId: true, domainId: true, productId: true, product: { select: { domainId: true } } } as const;

type OwnerRow = { tenantId: string; domainId?: string | null; productId?: string | null; product?: { domainId?: string | null } | null };

/** A row with its own tenant / domain / product columns. A row in a product whose domain column is empty takes its product's domain, so a domain role still reaches it. */
const ownerRef = (row: OwnerRow): ResourceRef => ({ tenantId: row.tenantId, domainId: row.domainId ?? row.product?.domainId ?? null, productId: row.productId ?? null });
const domainRef = (tenantId: string, domainId: string | null | undefined): ResourceRef => ({ tenantId, domainId: domainId ?? null, productId: null });

const RESOURCE_REFS = {
  entity: async (id: string) => {
    const row = await prisma.entity.findUnique({ where: { id }, select: OWNER });
    return row ? ownerRef(row) : null;
  },
  field: async (id: string) => {
    const row = await prisma.field.findUnique({ where: { id }, select: { entity: { select: OWNER } } });
    return row ? ownerRef(row.entity) : null;
  },
  domain: async (id: string) => {
    const row = await prisma.domain.findUnique({ where: { id }, select: { tenantId: true } });
    return row ? domainRef(row.tenantId, id) : null;
  },
  product: async (id: string) => {
    const row = await prisma.product.findUnique({ where: { id }, select: { domainId: true, domain: { select: { tenantId: true } } } });
    return row ? { tenantId: row.domain.tenantId, domainId: row.domainId ?? null, productId: id } : null;
  },
  model: async (id: string) => {
    const row = await prisma.modelDefinition.findUnique({ where: { id }, select: { domainId: true, domain: { select: { tenantId: true } } } });
    return row ? domainRef(row.domain.tenantId, row.domainId) : null;
  },
  modelField: async (id: string) => {
    const row = await prisma.modelFieldDefinition.findUnique({ where: { id }, select: { model: { select: { domainId: true, domain: { select: { tenantId: true } } } } } });
    return row ? domainRef(row.model.domain.tenantId, row.model.domainId) : null;
  },
  sharedEnum: async (id: string) => {
    const row = await prisma.sharedEnum.findUnique({ where: { id }, select: OWNER });
    return row ? ownerRef(row) : null;
  },
  customScalar: async (id: string) => {
    const row = await prisma.customScalar.findUnique({ where: { id }, select: OWNER });
    return row ? ownerRef(row) : null;
  },
  unionType: async (id: string) => {
    const row = await prisma.unionType.findUnique({ where: { id }, select: OWNER });
    return row ? ownerRef(row) : null;
  },
  service: async (id: string) => {
    const row = await prisma.serviceDefinition.findUnique({ where: { id }, select: OWNER });
    return row ? ownerRef(row) : null;
  },
  operation: async (id: string) => {
    const row = await prisma.operation.findUnique({ where: { id }, select: { service: { select: OWNER } } });
    return row ? ownerRef(row.service) : null;
  },
  event: async (id: string) => {
    const row = await prisma.eventSpec.findUnique({ where: { id }, select: OWNER });
    return row ? ownerRef(row) : null;
  },
  trait: async (id: string) => {
    const row = await prisma.trait.findUnique({ where: { id }, select: OWNER });
    return row ? ownerRef(row) : null;
  },
} as const;

/** The kinds of stored row `resolveResourceRef` can place (one per model the actions address by a bare id). */
export type ResourceKind = keyof typeof RESOURCE_REFS;

/**
 * The tenant, domain and product a row lives under, or null when there is no such row. A malformed id (not a non-blank string) and a kind
 * that is not one of ours are null WITHOUT a query, so a client-supplied value can never reach a Prisma validator and come back as its message.
 * A database failure propagates (callers answer it generically, never as "not found").
 */
export async function resolveResourceRef(kind: ResourceKind, id: unknown): Promise<ResourceRef | null> {
  if (typeof id !== "string" || id.trim() === "") return null;
  if (typeof kind !== "string" || !Object.hasOwn(RESOURCE_REFS, kind)) return null;
  return RESOURCE_REFS[kind](id);
}

/** What a guarded call is about: where the resource lives (a reference), or a stored row to look up (kind and id). */
export type AccessSubject = ResourceRef | { kind: ResourceKind; id: unknown };

const isRowSubject = (subject: AccessSubject): subject is { kind: ResourceKind; id: unknown } =>
  typeof subject === "object" && subject !== null && "kind" in subject;

/**
 * `authorizeInActiveTenant` for a subject that may still have to be looked up (a stored row by kind and id). A row that does not exist, a row
 * of another tenant than the active one and a row the principal cannot see all answer with the same `notFound` (default: `notFoundError()`),
 * so the caller's wire shape stays one thing. On success the principal and the resolved resource come back (the resource is what
 * `contextOf` and the caller's later checks are judged over).
 */
export async function authorizeSubject(
  action: ActionId,
  subject: AccessSubject,
  notFound: ServiceError = notFoundError()
): Promise<Result<{ principal: Principal; resource: ResourceRef }, ServiceError>> {
  return authorizeLoaded(
    action,
    async () => {
      const resource = isRowSubject(subject) ? await resolveResourceRef(subject.kind, subject.id) : subject;
      return resource ? ok(resource) : err(notFoundError());
    },
    notFound
  );
}

/**
 * The service context of an authorized call: the user, the assignments the policy judged (a service that must decide for itself asks `can` /
 * `grantAllowed` over them) and `userRole`, which is the role held at PLATFORM scope only (the lowest rung when none): the resource-relative
 * label that used to be here let a tenant administrator look like "the" ADMIN to a service that compares it, and a migrated steward look like a
 * viewer. The label never decides a permission over a resource; only the policy does.
 */
export function contextOf(principal: Principal): ServiceContext {
  return { userId: principal.userId, userRole: contextRole(principal.assignments), assignments: principal.assignments, prisma };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Active-tenant guards (the older, role-less ownership checks). Task 5 moves each caller to `authorize`; until then they keep
// their call shapes: the row must lie in the caller's ACTIVE tenant, and the active tenant is one the caller may access.
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Soft-grouping scope guard for rows addressed by a bare id (the older data-type / API / model-field / entity-field actions
 * take no owner target): the row must belong to the caller's ACTIVE tenant, the same scoping the pages and the Events
 * actions use. A row of another tenant reads exactly like a missing one (callers answer NOT_FOUND, never FORBIDDEN), so an
 * id guessed from another tenant reveals nothing. A caller who may access no tenant at all (`NoTenantAccess`) is outside every one.
 */
export async function isInActiveTenant(rowTenantId: string | null | undefined): Promise<boolean> {
  if (typeof rowTenantId !== "string") return false;
  try {
    return rowTenantId === (await getActiveTenantId());
  } catch (e: unknown) {
    if (isNoTenantAccess(e)) return false;
    throw e;
  }
}

/** The kinds of by-id row `inActiveTenant` can check: the kinds `resolveResourceRef` places. */
export type TenantScopedKind = ResourceKind;

/**
 * The by-id ownership guard of the older entity / model / API / data-type / product actions: true only when the row `id` names
 * exists AND (itself, or through its parent: field -> entity, model field -> model -> domain, operation -> service,
 * product -> domain) belongs to the caller's ACTIVE tenant (`isInActiveTenant`). A malformed id, a missing row and a row of
 * another tenant are all `false`, so a caller answers the three with the one identical NOT_FOUND and an id guessed from
 * another tenant reveals nothing. Create-style actions pass their PARENT id (an entity for a field, a model for a model
 * field, a service for an operation, a domain for a product). Call it before any read of or write to the row.
 *
 * It asks for NO role: the role-aware guard is `authorize` / `authorizeSubject` (Task 5 migrates the callers).
 */
export async function inActiveTenant(kind: TenantScopedKind, id: unknown): Promise<boolean> {
  if (typeof id !== "string" || id.trim() === "") return false;
  return isInActiveTenant((await resolveResourceRef(kind, id))?.tenantId);
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

/** The not-found answer for a scope target: the one `resolveScope` gives a missing one, and so the one for every target the caller may not see. */
const missingTargetError = (target: ScopeTarget): ServiceError => ({ code: "NOT_FOUND", message: missingTargetMessage(target) });

/**
 * Where a create's `ScopeTarget` (a domain or product id taken from the client) lives, when it lies in the ACTIVE tenant: resolves the
 * target and answers the very NOT_FOUND `resolveScope` gives a missing one when it belongs to another tenant. A malformed target (not an
 * object, a non-string or blank id) is NOT_FOUND too, WITHOUT a query: it can never reach a Prisma validator and come back as its message.
 */
async function ownedTargetRef(target: ScopeTarget): Promise<Result<ResourceRef>> {
  if (typeof target !== "object" || target === null) return err({ code: "NOT_FOUND", message: "Target not found" });
  const { id } = targetId(target);
  if (typeof id !== "string" || id.trim() === "") return err(missingTargetError(target));
  const scope = await resolveScope(prisma, target);
  if (!scope.success) return scope;
  if (!(await isInActiveTenant(scope.data.tenantId))) return err(missingTargetError(target));
  return ok({ tenantId: scope.data.tenantId, domainId: scope.data.domainId, productId: scope.data.productId });
}

/** Where a create's target lives, whatever tenant that is (the tenant in view is decided by `authorizeInActiveTenant`'s caller, `authorizeLoaded`). */
async function resolveTargetRef(target: ScopeTarget): Promise<Result<ResourceRef, ServiceError>> {
  const scope = await resolveScope(prisma, target);
  if (!scope.success) return scope;
  return ok({ tenantId: scope.data.tenantId, domainId: scope.data.domainId, productId: scope.data.productId });
}

/** What a malformed target (not a well-formed `ScopeTarget`) is answered when an action asks for it: a NOT_FOUND, the same for every malformed value. */
const MALFORMED_TARGET_ERROR: ServiceError = { code: "NOT_FOUND", message: "Target not found" };

/**
 * `inActiveTenant` for a create's `ScopeTarget`: succeeds when the target lies in the active tenant, else the NOT_FOUND `resolveScope`
 * gives a missing one. Success carries nothing: the write that follows re-resolves the target itself. Asks for no role (see `inActiveTenant`).
 */
export async function targetInActiveTenant(target: ScopeTarget): Promise<Result<undefined>> {
  const owned = await ownedTargetRef(target);
  return owned.success ? ok(undefined) : owned;
}

type Guarded<T> = () => Promise<Result<T>>;

/**
 * The PARENT check of the Events actions (channels, messages, event specs, traits and their publish / preview / list actions):
 * they take a CLIENT-supplied product (or owner target) and the services only compare the row against that owner, so an owner
 * of another tenant would be self-consistent. A well-formed `target` must lie in the ACTIVE tenant, else its failure is exactly
 * the NOT_FOUND `resolveScope` gives an unknown one and `run` (the service call) never starts. A malformed target skips the
 * check on purpose: the service parses it with the same `parseScopeTarget` and answers its own VALIDATION_ERROR, so no write is
 * reachable and that answer stays unchanged. The service-level `assertOwnedBy` stays behind this check.
 *
 * With an `action` (`withOwnedTarget(action, target, run)`) the guard is `authorizeInActiveTenant`: the target must lie in the ACTIVE tenant
 * AND the principal must be allowed `action` over it. A target they cannot see (missing, another tenant, nothing of theirs covers it) is
 * answered with the missing-target NOT_FOUND above (identical, whole), one they can see but hold too low a role over is FORBIDDEN,
 * generic. A MALFORMED target FAILS CLOSED: the same NOT_FOUND for every malformed value, no look-up, and `run` never starts (a `run` that
 * does not re-parse the very value would otherwise be reached with no authorization at all).
 *
 * Without an action it is the older role-less check (the leniency for a malformed target belongs to that adapter only: the service parses
 * it with the same `parseScopeTarget` and answers its own VALIDATION_ERROR). Task 5 gives each remaining caller its action and removes it.
 */
export async function withOwnedTarget<T>(action: ActionId, target: unknown, run: Guarded<T>): Promise<Result<T>>;
export async function withOwnedTarget<T>(target: unknown, run: Guarded<T>): Promise<Result<T>>;
export async function withOwnedTarget<T>(...args: [ActionId, unknown, Guarded<T>] | [unknown, Guarded<T>]): Promise<Result<T>> {
  const [action, target, run] = args.length === 3 ? args : [null, args[0], args[1]];
  const parsed = parseScopeTarget(target);
  if (action !== null) {
    if (!parsed.success) return err({ ...MALFORMED_TARGET_ERROR });
    const allowed = await authorizeLoaded(action, () => resolveTargetRef(parsed.data), missingTargetError(parsed.data));
    if (!allowed.success) return err(allowed.error);
    return run();
  }
  if (parsed.success) {
    const owned = await ownedTargetRef(parsed.data);
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
 * message: raw driver / Prisma / TypeError text (paths, source excerpts, column names) never reaches the browser. A caller with no
 * tenant access (`NoTenantAccess`) is answered NOT_FOUND.
 */
export function unexpectedFailure(label: string, e: unknown) {
  unstable_rethrow(e);
  if (e instanceof AuditUserMissingError) return { error: STALE_SESSION_ERROR, code: "UNAUTHORIZED" as const };
  // A caller who may access no tenant at all sees nothing: the answer is the not-found every refusal to see gets, not an error.
  if (isNoTenantAccess(e)) return { error: NOT_FOUND_MESSAGE, code: "NOT_FOUND" as const };
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

/** What a guarded mutation needs before it may run: the action it performs and the resource it performs it on. */
export type MutationAccess = {
  action: ActionId;
  /** Where the resource lives (a reference), or a stored row to look up (kind and id). */
  resource: AccessSubject;
  /** The answer for a resource that does not exist AND for one the principal cannot see (default `notFoundError()`): one shape for both. */
  notFound?: ServiceError;
};

type Mutation<T> = (ctx: ServiceContext) => Promise<Result<T>>;

/**
 * The shared shape of every mutating server action: authenticate, authorize, run the service call, and
 * revalidate `/schemas` (layout) on success only (`staleTimes.dynamic = 30` would otherwise serve stale pages).
 * Read-only actions use `authorize` + `toActionResult` directly and never revalidate. A failed Result goes through
 * `toActionResult`, so a `DB_ERROR` / `INTERNAL_ERROR` never reaches the browser with its raw text (`label` names the action
 * in the server-side log of that failure).
 *
 * `runMutation({ action, resource }, run, label)`: `authorizeSubject` decides first (nobody: NOT_AUTHENTICATED; a resource outside the active
 * tenant or one the principal cannot see: NOT_FOUND, the answer a missing one gets; too low a role: FORBIDDEN) and `run` gets `contextOf`
 * the principal (the assignments the policy judged; no role label over the resource). `runMutation(run, label)` is the older call shape,
 * kept as an adapter until Task 5 gives each caller its action: it authenticates through the legacy `getActionContext` and asks for no role.
 *
 * An unexpected REJECTION from the session lookup or from `run` (a driver / Prisma validation error from a service that
 * lets malformed client input reach a query, a lost connection) is caught here as well: it is logged server-side and
 * returned as a generic `INTERNAL_ERROR` instead of an unhandled 500 carrying the raw text. Next's own control-flow throws
 * (`redirect()`, `notFound()`, `forbidden()`, `unauthorized()`, dynamic-rendering bailouts) are NOT failures: they are
 * re-thrown untouched through `unstable_rethrow`, which owns the list of such errors (digest `NEXT_REDIRECT`,
 * `NEXT_HTTP_ERROR_FALLBACK;…`, …), so the framework still sees them. A caller with no tenant access (`NoTenantAccess`, thrown by a
 * service or guard that asks for the active tenant) is answered NOT_FOUND. Revalidation sits outside the try: a write that
 * has already committed is never reported as a failure.
 */
export async function runMutation<T>(access: MutationAccess, run: Mutation<T>, label?: string): Promise<ActionResult<T>>;
export async function runMutation<T>(run: Mutation<T>, label?: string): Promise<ActionResult<T>>;
export async function runMutation<T>(first: MutationAccess | Mutation<T>, second?: Mutation<T> | string, third?: string): Promise<ActionResult<T>> {
  const legacy = typeof first === "function";
  const access = legacy ? null : first;
  const run = (legacy ? first : second) as Mutation<T>;
  const label = ((legacy ? second : third) as string | undefined) ?? "mutation";

  let result: Result<T>;
  try {
    let ctx: ServiceContext | null;
    if (access) {
      const allowed = await authorizeSubject(access.action, access.resource, access.notFound);
      if (!allowed.success) return toActionResult({ success: false, error: allowed.error }, label);
      ctx = contextOf(allowed.data.principal);
    } else {
      ctx = await getActionContext();
    }
    if (!ctx) return NOT_AUTHENTICATED;
    result = await run(ctx);
  } catch (e: unknown) {
    unstable_rethrow(e);
    if (isNoTenantAccess(e)) return { success: false, error: NOT_FOUND_MESSAGE, code: "NOT_FOUND" };
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
