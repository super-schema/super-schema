/**
 * Auth.js's `trustHost` option, written out (it used to be left to Auth.js's own default, `!!(AUTH_URL ?? AUTH_TRUST_HOST ?? VERCEL ?? CF_PAGES ??
 * NODE_ENV !== "production")`, which reads ANY set value as true, `AUTH_TRUST_HOST=false` included, and reads an empty `AUTH_URL` as "do not trust"
 * even in development). The rule is the one docs/auth-ops.md states:
 *
 *   - development and test: trusted (nothing is exposed);
 *   - production: trusted when `AUTH_URL` names the public origin (Auth.js then builds its URLs from it, not from the Host header) or when the
 *     operator says `AUTH_TRUST_HOST=true` (or `1`), which is right behind a reverse proxy that sets the Host header;
 *   - otherwise NOT trusted: every request is refused as `UntrustedHost` rather than building URLs from a Host header a client wrote.
 *
 * `NEXTAUTH_URL` alone does not trust the host (the compose file sets it AND `AUTH_TRUST_HOST`), and the platform defaults of Auth.js (`VERCEL`,
 * `CF_PAGES`) are not applied: set `AUTH_URL` or `AUTH_TRUST_HOST=true` there. This is about the Host header; `AUTH_TRUST_PROXY` (the client address
 * for throttling, src/lib/auth/throttle.ts) is a different question.
 */
export function resolveTrustHost(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.NODE_ENV !== "production") return true;
  if ((env.AUTH_URL ?? "").trim() !== "") return true;
  const trust = (env.AUTH_TRUST_HOST ?? "").trim().toLowerCase();
  return trust === "true" || trust === "1";
}
