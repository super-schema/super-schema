/**
 * Where the login page may send a user after signing in: the page the middleware redirected from (`/login?callbackUrl=<page>`), but
 * only when that is a path of THIS site. The parameter is attacker-controlled (a link `/login?callbackUrl=//evil.com` is one click
 * away), so everything else is the default, never an error.
 *
 * Accepted: a string of at most 2048 characters that starts with exactly one `/`, has no backslash and no control character (browsers
 * drop tabs and newlines inside a URL, so `/\t/evil.com` is `//evil.com`), still starts with one `/` after ONE percent-decoding
 * (`/%5Cevil.com`, `/%2Fevil.com`), parses against a dummy origin to that same origin, and whose normalised path is neither the login
 * and register pages (a loop) nor under `/api/` (an endpoint, not a page). The value that is returned is the parsed
 * `pathname + search + hash`, and it is checked again, because `/..//evil.com` normalises to `//evil.com`.
 */
export const DEFAULT_AFTER_LOGIN = "/schemas";

const MAX_LENGTH = 2048;
const DUMMY_ORIGIN = "http://callback.invalid";
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
/** Pages that must not be a destination (the sign-in pages: a loop), and the endpoints. */
const EXCLUDED_PATHS = ["/login", "/register", "/api"];

const startsOneSlash = (value: string) => value.startsWith("/") && !value.startsWith("//");

export function safeCallbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return DEFAULT_AFTER_LOGIN;
  if (!startsOneSlash(value) || CONTROL_OR_BACKSLASH.test(value)) return DEFAULT_AFTER_LOGIN;

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  if (!startsOneSlash(decoded) || CONTROL_OR_BACKSLASH.test(decoded)) return DEFAULT_AFTER_LOGIN;

  let url: URL;
  try {
    url = new URL(value, DUMMY_ORIGIN);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  if (url.origin !== DUMMY_ORIGIN) return DEFAULT_AFTER_LOGIN;

  const path = url.pathname.toLowerCase();
  if (EXCLUDED_PATHS.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) return DEFAULT_AFTER_LOGIN;

  const result = url.pathname + url.search + url.hash;
  return startsOneSlash(result) ? result : DEFAULT_AFTER_LOGIN;
}
