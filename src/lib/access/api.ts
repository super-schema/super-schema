/**
 * `withApiAuth(action, handler)`: the one guard in front of every API route handler that serves tenant data (access-control design, goal 3).
 *
 * What it does BEFORE the handler runs, in this order, and the handler never runs when any of it says no:
 *  1. `options.before` (the rate limit: it counts requests that carry no credential too);
 *  2. who is calling: the API key (a service principal) or the session's principal (`authenticateRequest`); nobody is a 401;
 *  3. the acting TENANT: the key's own tenant, or the session's active tenant (one the user holds a role in). A caller who may reach no
 *     tenant (`NoTenantAccess`: no role yet, a disabled user) is told the same 404 as for a resource that does not exist, never a 500;
 *  4. may this principal perform `action` here at all: a principal with no role in the tenant is a 404 ("Not found", no existence oracle),
 *     one that has a role in it but none that reaches the action is a 403. Which ROWS they may read is decided by the handler, with the
 *     `scopes` handed to it (`readableScopes`) or the service behind it; a platform action (`platform.admin`) needs a GLOBAL administrator
 *     and a `self` action (own notifications) any principal.
 *
 * What the caller is answered is the route's own envelope (`options.respond`): the REST API's `{ success, error: { code, message } }` by
 * default, or the shapes the app's own JSON endpoints always had (`APP_ERRORS`, `COMPLIANCE_ERRORS`). Messages are generic and name no role,
 * action, tenant or id.
 */

import { NextResponse } from "next/server";
import { apiError, apiServerError, apiUnauthorized } from "@/app/api/v1/error-handler";
import { authenticateRequest, type AuthResult } from "@/app/api/v1/middleware";
import { contextOf } from "@/lib/action-context";
import { getActiveTenantId } from "@/lib/active-tenant";
import { ACTIONS, can, isActionId, readableScopes, type ActionId, type ReadableScopes } from "@/lib/access";
import { isNoTenantAccess } from "@/lib/access/no-tenant-access";
import type { Principal } from "@/lib/access/principal";
import type { ServiceContext } from "@/types/service-context";

/** What is handed to the handler of a request that passed the guard. */
export type ApiAuth = {
  source: "api-key" | "session";
  principal: Principal;
  /** The tenant the request acts in; null only for a platform or `self` action, which are not about a tenant. */
  tenantId: string | null;
  /** The rows of the tenant the principal may read for the action: every row, or only those under these domains and products. Null with no tenant. */
  scopes: ReadableScopes | null;
  /** The service context of the call: the principal's user and assignments, and the tenant in view (a service that reads across rows restricts to it). */
  ctx: ServiceContext;
};

export type Denial = {
  status: 401 | 403 | 404 | 500;
  code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "INTERNAL_ERROR";
  message: string;
};

/** How a refusal is written for the route's callers. */
export type ErrorShape = (denial: Denial) => Response;

/** The REST API's envelope: `{ success: false, error: { code, message, suggestedFix? } }`. */
export const V1_ERRORS: ErrorShape = ({ status, code, message }) =>
  status === 401 ? apiUnauthorized() : status === 500 ? apiServerError() : apiError({ code, message });

/** The app's own JSON endpoints: `{ error: "<message>" }` (what the middleware answers for a missing session, too). */
export const APP_ERRORS: ErrorShape = ({ status, message }) => NextResponse.json({ error: message }, { status });

/** The compliance endpoints: `{ success: false, error: "<message>" }`. */
export const COMPLIANCE_ERRORS: ErrorShape = ({ status, message }) => NextResponse.json({ success: false, error: message }, { status });

export type ApiAuthOptions = {
  /** Runs first, before the credential is looked at (the rate limit); a Response ends the request. */
  before?: (request: Request) => Response | null;
  /** How a refusal is written (default: the REST API's envelope). */
  respond?: ErrorShape;
  /** The answer for a caller with no credential, in place of the 401 (the notification bell polls and wants a count, not an error); null keeps the 401. */
  unauthenticated?: (request: Request) => Response | null;
  /** The answer when looking up who is calling failed (the database); null keeps the generic 500. */
  authFailure?: (request: Request) => Response | null;
  /** `false`: the route answers to a session only, a bearer token is ignored (the app's own endpoints). Default `true`. */
  allowApiKey?: boolean;
};

const FORBIDDEN_MESSAGE = "You do not have permission to do this";
const NOT_FOUND_MESSAGE = "Not found";
const NOT_AUTHENTICATED_MESSAGE = "Not authenticated";
const SERVER_ERROR_MESSAGE = "Internal server error";

const refuse = (respond: ErrorShape, status: Denial["status"]): Response => {
  switch (status) {
    case 401:
      return respond({ status, code: "UNAUTHORIZED", message: NOT_AUTHENTICATED_MESSAGE });
    case 403:
      return respond({ status, code: "FORBIDDEN", message: FORBIDDEN_MESSAGE });
    case 404:
      return respond({ status, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE });
    case 500:
      return respond({ status, code: "INTERNAL_ERROR", message: SERVER_ERROR_MESSAGE });
  }
};

/** The platform actions ignore the resource; `can` still wants one. No tenant has this id, so only a GLOBAL assignment covers it. */
const NO_PLACE = { tenantId: "-" } as const;

type RouteContext<P> = { params: Promise<P> };

/** The handler of a guarded route: the request, the guard's answer and Next's route context (`params`). */
export type ApiHandler<P> = (request: Request, api: ApiAuth, route: RouteContext<P>) => Promise<Response> | Response;

/**
 * Wrap a route handler. The returned function is what the route exports (`export const GET = withApiAuth("entity.read", async (request, api) => ...)`).
 * `action` is the policy action the route performs (src/lib/access/actions.ts); an id that is not in the table is refused for everyone.
 */
export function withApiAuth<P = Record<string, string>>(
  action: ActionId,
  handler: ApiHandler<P>,
  options: ApiAuthOptions = {}
): (request: Request, route: RouteContext<P>) => Promise<Response> {
  const respond = options.respond ?? V1_ERRORS;
  return async (request, route) => {
    const early = options.before?.(request);
    if (early) return early;

    let authenticated: AuthResult;
    try {
      authenticated = await authenticateRequest(request, { allowApiKey: options.allowApiKey ?? true });
    } catch (e: unknown) {
      console.error("[api] could not tell who is calling", e);
      return options.authFailure?.(request) ?? refuse(respond, 500);
    }
    if (!authenticated.authenticated) return options.unauthenticated?.(request) ?? refuse(respond, 401);
    const { principal, source } = authenticated;

    if (!isActionId(action)) return refuse(respond, 403); // an action id that is not in the table is a bug: never allowed
    const spec = ACTIONS[action];

    try {
      // A platform action and an own-things action are not about a place: the principal alone decides.
      if (spec.level === "self" || spec.level === "global") {
        if (!can(principal.assignments, action, NO_PLACE)) return refuse(respond, 403);
        const ctx = contextOf(principal);
        return await handler(request, { source, principal, tenantId: authenticated.tenantId, scopes: null, ctx }, route);
      }

      // Content: the acting tenant first (a caller who may reach none is "not found", exactly as for a missing resource) ...
      const tenantId = authenticated.tenantId ?? (await getActiveTenantId(principal));
      if (!can(principal.assignments, "tenant.access", { tenantId })) return refuse(respond, 404);
      // ... then whether any role of theirs reaches the action there (the rows are the handler's to filter, with these scopes).
      const scopes = readableScopes(principal.assignments, action, tenantId);
      if (!scopes.all && scopes.domainIds.length === 0 && scopes.productIds.length === 0) return refuse(respond, 403);

      const ctx: ServiceContext = { ...contextOf(principal), tenantId };
      return await handler(request, { source, principal, tenantId, scopes, ctx }, route);
    } catch (e: unknown) {
      if (isNoTenantAccess(e)) return refuse(respond, 404);
      console.error("[api] unexpected error", e);
      return refuse(respond, 500);
    }
  };
}
