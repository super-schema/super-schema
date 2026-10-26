/**
 * The few server actions and route handlers that are open ON PURPOSE: they cannot ask who the caller is because the caller is not signed
 * in yet (registration, the invitation and reset links), or they are infrastructure and documentation that carry no tenant content.
 * Every other exported server action and every other route handler must be guarded, and
 * `tests/unit/access/deny-by-default.test.ts` fails for one that is neither guarded nor listed here (access-control design, goal 3).
 *
 * An entry is a reason of ONE line (no line break) saying why it is safe to be open. Adding an entry is a security decision: it belongs in
 * review next to the function it exempts. A listed function that is removed or renamed must leave the list (the test says so).
 */

/** Server actions, keyed `<file path>#<exported function name>`. */
export const PUBLIC_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  "src/app/(auth)/register/actions.ts#registerAction": "pre-sign-in registration: honours the registration mode, throttled per address, uniform answers, creates a role-less account",
  "src/app/(auth)/invite/[token]/actions.ts#acceptInvitationAction": "pre-sign-in: a single-use invitation token IS the credential (hashed at rest, one atomic claim, throttled per address)",
  "src/app/(auth)/login/provider-actions.ts#signInWithProvider": "pre-sign-in: starts Auth.js's sign-in for a provider the registry has enabled (any other id is refused), toward a path of this site; who may sign in is decided afterwards by the signIn callback (the user must already exist, not be disabled; throttled per address)",
  "src/app/(auth)/reset/[token]/actions.ts#consumeResetAction": "pre-sign-in: a single-use reset token IS the credential (hashed at rest, one atomic claim, throttled per address)",
});

/**
 * Route handlers, keyed by route path (a trailing `/*` covers everything below it). Every HTTP method of a listed route is open: list a
 * route here only when none of them returns tenant content.
 */
export const PUBLIC_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  "/api/auth/*": "Auth.js endpoints: sign-in, callbacks, CSRF and session (they authenticate; they hold no tenant content)",
  "/api/v1/health": "liveness probe for the load balancer: answers up or down, and the detailed report only to a platform administrator",
  "/api/v1/docs": "the public API reference page (static OpenAPI text, no tenant content)",
  "/api/asyncapi-preview/*": "static AsyncAPI preview assets (no tenant content)",
});

/** Is `routePath` (`/api/v1/schemas/[id]`) covered by an entry of `PUBLIC_ROUTES`? */
export function isPublicRoute(routePath: string): boolean {
  return Object.keys(PUBLIC_ROUTES).some((entry) => (entry.endsWith("/*") ? routePath === entry.slice(0, -2) || routePath.startsWith(entry.slice(0, -1)) : routePath === entry));
}
