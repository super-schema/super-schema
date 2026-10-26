/**
 * The REST API key as a SERVICE PRINCIPAL (access-control design, decision 11). `API_KEY` (a secret, unchanged) authenticates
 * `Authorization: Bearer <key>` on `/api/v1/*`; the key acts as a principal bound to
 *
 *  - `API_KEY_TENANT_ID`: the tenant it acts in (default: the default tenant). The content routes answer only for resources of that tenant,
 *    whatever role the key has (the acting tenant of a request, as a session's active tenant is).
 *  - `API_KEY_ROLE`: the role it holds (default `ADMIN`, so integrations that existed before access control keep working).
 *
 * Trade-off, documented in docs/auth-ops.md: an `ADMIN` key is a PLATFORM administrator, as the key has always been (the webhook routes are
 * platform items), but its content access is confined to its tenant. A key that only reads schemas should be given `API_KEY_ROLE=VIEWER`
 * (a role in the tenant, no platform rights). An `API_KEY_ROLE` that is not a role disables the key (it never falls back to ADMIN): a typo
 * must not widen what the key may do.
 *
 * Pure: the environment is a parameter, nothing is read from a database, nothing throws.
 */

import crypto from "node:crypto";
import { isRole, type Assignment, type Role } from "@/types/schemas/rbac";
import type { Principal } from "./principal";
import { can } from "./policy";
import { isValidAssignment } from "./scope";

/** The id a key's principal carries: it is no row of `users`, so it has no mailbox, no audit identity and no foreign-key target. */
export const API_KEY_USER_ID = "api-key-user";
/** Is `userId` the service principal of the API key (not a user row: nothing may reference it as a creator or owner)? */
export const isServiceUserId = (userId: unknown): boolean => userId === API_KEY_USER_ID;
/** The role the key holds when `API_KEY_ROLE` is not set (what the key has always been: an administrator). */
export const DEFAULT_API_KEY_ROLE: Role = "ADMIN";
/** The tenant the key acts in when `API_KEY_TENANT_ID` is not set (`DEFAULT_TENANT_ID` of src/lib/org-defaults.ts, which imports the database: restated and test-pinned). */
export const DEFAULT_API_KEY_TENANT_ID = "tenant_default";

type Env = Readonly<Record<string, string | undefined>>;

/** What the key stands for, or `null` when API-key authentication is off (no `API_KEY`, or an `API_KEY_ROLE` that is not a role). */
export type ApiKeyPrincipal = { principal: Principal; tenantId: string; role: Role };

/** The text of a setting with surrounding space removed, or undefined when it is not set (unset and blank are the same: the default). */
function setting(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The service principal the configured key stands for. An `ADMIN` key holds a GLOBAL administrator assignment (the platform items it has
 * always reached); any other role is held at TENANT scope in `API_KEY_TENANT_ID` only. The acting tenant is `tenantId` either way.
 */
export function apiKeyPrincipal(env: Env = process.env): ApiKeyPrincipal | null {
  if (!setting(env, "API_KEY")) return null;
  const configuredRole = setting(env, "API_KEY_ROLE") ?? DEFAULT_API_KEY_ROLE;
  if (!isRole(configuredRole)) return null;
  const role: Role = configuredRole;
  const tenantId = setting(env, "API_KEY_TENANT_ID") ?? DEFAULT_API_KEY_TENANT_ID;
  // The role that may be held at PLATFORM scope (the policy's validity rule: GLOBAL is for the administrator only) is held there; any other at TENANT scope.
  const platformRole = isValidAssignment(role, { kind: "GLOBAL" });
  const assignments: Assignment[] = platformRole ? [{ role, scope: { kind: "GLOBAL" } }] : [{ role, scope: { kind: "TENANT", tenantId } }];
  const principal: Principal = Object.freeze({
    userId: API_KEY_USER_ID,
    email: "api-key@service.invalid",
    assignments: Object.freeze(assignments) as Assignment[],
    isGlobalAdmin: can(assignments, "platform.admin", { tenantId }),
  });
  return { principal, tenantId, role };
}

const digest = (value: string): Buffer => crypto.createHash("sha256").update(value, "utf8").digest();

/**
 * Is `presented` the configured key? Compared in constant time: both sides are hashed to the same length first, so neither the content
 * nor the LENGTH of the key shows in how long the comparison takes. False when no key is configured.
 */
export function apiKeyMatches(presented: string, env: Env = process.env): boolean {
  const expected = env.API_KEY;
  if (typeof expected !== "string" || expected === "") return false;
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}
