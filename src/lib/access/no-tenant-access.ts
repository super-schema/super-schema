/**
 * Thrown by `getActiveTenantId` when the signed-in principal may access no tenant at all (no role assigned yet, or nobody: a disabled user,
 * a stale session). A page turns it into the "no access yet" screen (`/no-access`); an action or a route answers it as "not found", the
 * way every refusal to see is answered. Its own module with no imports, so a test that replaces `@/lib/active-tenant` still sees the class.
 */

/** Where a principal with no tenant access is sent: the "no access yet" screen. */
export const NO_ACCESS_PATH = "/no-access";

export class NoTenantAccess extends Error {
  readonly code = "NO_TENANT_ACCESS";

  constructor() {
    super("No tenant access");
    this.name = "NoTenantAccess";
  }
}

/**
 * Is `error` a `NoTenantAccess`? By class, and by name, because the class can be loaded twice (the server and the SSR layers of Next each
 * bundle a copy of a shared module) and `instanceof` is then false for an error that is one.
 */
export function isNoTenantAccess(error: unknown): error is NoTenantAccess {
  return error instanceof NoTenantAccess || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NoTenantAccess");
}
