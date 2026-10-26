/**
 * Where the login page may send a user after signing in: the page the middleware redirected from (`/login?callbackUrl=<page>`), but
 * only when that is a path of THIS site. The parameter is attacker-controlled (a link `/login?callbackUrl=//evil.com` is one click
 * away), so everything else is the default, never an error.
 *
 * Accepted: a string of at most 2048 characters that starts with exactly one `/`, has no backslash and no control character (browsers
 * drop tabs and newlines inside a URL, so `/\t/evil.com` is `//evil.com`), still starts with one `/` after percent-decoding, up to three
 * rounds (`/%5Cevil.com`, `/%2Fevil.com`, `/%252Fevil.com`), parses against a dummy origin to that same origin, and whose normalised
 * path is neither the login, register, invitation and reset pages (a loop: a signed-in user is sent away from them) nor under `/api/` (an endpoint, not a page). The value that is returned is the
 * parsed `pathname + search + hash`, and it is checked again in its own form and decoded, because `/..//evil.com` normalises to
 * `//evil.com` and `/./%2fevil.com` to `/%2fevil.com`, which decodes to `//evil.com`.
 */
export const DEFAULT_AFTER_LOGIN = "/schemas";

const MAX_LENGTH = 2048;
const DUMMY_ORIGIN = "http://callback.invalid";
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
/** Pages that must not be a destination (the sign-in pages: a loop), and the endpoints. */
const EXCLUDED_PATHS = ["/login", "/register", "/invite", "/reset", "/api"];

/** A router or a proxy may decode a path once (a double-encoded one twice) before it uses it: this many rounds are looked at. */
const MAX_DECODE_ROUNDS = 3;

const startsOneSlash = (value: string) => value.startsWith("/") && !value.startsWith("//");

/**
 * Whether `value`, and each of its percent-decodings (up to MAX_DECODE_ROUNDS, or until nothing changes), is still a path of this site: one
 * leading `/`, no backslash, no control character. A first decoding that cannot be made (a malformed escape) is a refusal; a LATER one that
 * cannot (`/search?q=100%25` decodes to `100%`, which has no escape left to read) simply ends the walk.
 */
function staysAPathWhenDecoded(value: string): boolean {
  let current = value;
  for (let round = 1; round <= MAX_DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return round > 1;
    }
    if (!startsOneSlash(next) || CONTROL_OR_BACKSLASH.test(next)) return false;
    if (next === current) return true;
    current = next;
  }
  return true;
}

export function safeCallbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return DEFAULT_AFTER_LOGIN;
  if (!startsOneSlash(value) || CONTROL_OR_BACKSLASH.test(value)) return DEFAULT_AFTER_LOGIN;
  if (!staysAPathWhenDecoded(value)) return DEFAULT_AFTER_LOGIN;

  let url: URL;
  try {
    url = new URL(value, DUMMY_ORIGIN);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  if (url.origin !== DUMMY_ORIGIN) return DEFAULT_AFTER_LOGIN;

  const path = url.pathname.toLowerCase();
  if (EXCLUDED_PATHS.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) return DEFAULT_AFTER_LOGIN;

  // What is returned is checked again, in its own form AND decoded: `/./%2fevil.com` normalises to `/%2fevil.com`, whose decoding is `//evil.com`.
  const result = url.pathname + url.search + url.hash;
  return startsOneSlash(result) && !CONTROL_OR_BACKSLASH.test(result) && staysAPathWhenDecoded(result) ? result : DEFAULT_AFTER_LOGIN;
}
