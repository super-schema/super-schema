/**
 * Does this request carry a VALID Auth.js session? Used by the middleware, which runs before any page or endpoint.
 *
 * The middleware used to look only at whether a cookie of a session name existed, so any value (`authjs.session-token=x`) passed as a
 * session. Here the cookie is decrypted and verified (signature, secret, expiry) with Auth.js's own `getToken`, under the two names
 * Auth.js v5 uses: `authjs.session-token`, and `__Secure-authjs.session-token` when the site is served over https (each name is its
 * own salt). The legacy `next-auth.session-token` names are not Auth.js v5's: a cookie of that name is never a session of this app.
 *
 * Fails closed: no secret configured, an undecryptable value, an expired or a foreign token are all "no session". Only the Cookie
 * header is read (never `Authorization: Bearer`, which `getToken` would also accept as a token).
 */
import { getToken } from "next-auth/jwt";

const SESSION_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

export async function hasValidSession(cookieHeader: string | null): Promise<boolean> {
  if (!cookieHeader) return false;
  // Auth.js reads AUTH_SECRET, and NEXTAUTH_SECRET as the name this app documents (src/env.ts, .env.example).
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) return false;

  const req = { headers: new Headers({ cookie: cookieHeader }) };
  for (const cookieName of SESSION_COOKIE_NAMES) {
    // The name is in the header, or there is nothing to decrypt under this salt.
    if (!cookieHeader.includes(cookieName)) continue;
    const token = await getToken({ req, secret, cookieName, secureCookie: cookieName.startsWith("__Secure-") });
    if (token) return true;
  }
  return false;
}
