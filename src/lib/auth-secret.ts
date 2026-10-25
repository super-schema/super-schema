/**
 * The secret that signs the session cookie (the Auth.js JWT) is the whole authentication boundary of the app: the middleware verifies the
 * cookie with it (src/lib/session-cookie.ts) and Auth.js signs it with it (src/lib/auth.ts). Two places must therefore read the SAME secret,
 * and this is the one place that decides which: `AUTH_SECRET` (the name Auth.js documents), else `NEXTAUTH_SECRET` (the name this app's
 * `.env.example` and compose file use). A name set to the EMPTY string is not set, in both places: Auth.js's own `AUTH_SECRET ?? NEXTAUTH_SECRET`
 * would stop at an empty `AUTH_SECRET` (an empty string is not nullish) and sign with nothing, while the middleware (`||`) went on to
 * `NEXTAUTH_SECRET`: the two would disagree about which logins are valid.
 *
 * Not supported: Auth.js's `AUTH_SECRET_1..3` rotation. Auth.js reads them only when it has no secret of its own; the middleware reads only
 * the two names above, so with rotation names alone it has no secret and FAILS CLOSED (every request bounces to /login). docs/auth-ops.md.
 *
 * In production the secret must be strong: `productionSecretProblem` says why a value is refused, and `assertProductionAuthSecret` (called
 * when the server starts: src/instrumentation.ts) throws it.
 */

type Env = Record<string, string | undefined>;

/** The secret the session cookie is signed with: `AUTH_SECRET`, else `NEXTAUTH_SECRET`; a name that is empty is not set. */
export function resolveAuthSecret(env: Env = process.env): string | undefined {
  for (const name of ["AUTH_SECRET", "NEXTAUTH_SECRET"] as const) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** The shortest secret a production server accepts: 32 characters (`openssl rand -base64 32` is 44, `openssl rand -hex 32` is 64). */
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/** Values that are known development secrets (compose files, `.env.example`, tutorials); compared case-insensitively, trimmed. */
const KNOWN_DEVELOPMENT_SECRETS: ReadonlySet<string> = new Set([
  "secret",
  "secrets",
  "changeme",
  "change-me",
  "change_me",
  "password",
  "default",
  "development",
  "dev",
  "test",
  "testing",
  "example",
  "your-secret-here",
  "your-secret",
  "your_secret_here",
  "supersecret",
  "super-secret",
  "mysecret",
  "my-secret",
  "nextauth-secret",
  "auth-secret",
  "dev-secret",
  "dev-auth-secret",
  "dev-secret-change-in-production",
  "development-secret",
  "secret-change-in-production",
  "change-in-production",
  "please-change-me",
  "replace-me",
]);

/** A value that is a placeholder in any case: it says to change it ("...change-in-production", "your-secret-here", "replace_me"). */
const PLACEHOLDER = /change[-_ ]?(me|in[-_ ]?prod(uction)?)|your[-_ ]?secret|replace[-_ ]?me|dev(elopment)?[-_ ]secret/i;

/**
 * Why a production server refuses this secret, or null when it is acceptable: missing, shorter than 32 characters, or a known development
 * value or placeholder. The text is the whole message, with how to make a good one. Pure.
 *
 * @param secret the effective secret (`resolveAuthSecret`)
 */
export function productionSecretProblem(secret: string | undefined): string | null {
  const how = "Generate one with `openssl rand -base64 32` and set it as AUTH_SECRET (or NEXTAUTH_SECRET).";
  if (secret === undefined) {
    return `no session secret is set: AUTH_SECRET / NEXTAUTH_SECRET are both missing or empty. ${how} (Auth.js's AUTH_SECRET_1..3 rotation names alone are not enough: the middleware reads only the two names above.)`;
  }
  const normalized = secret.trim().toLowerCase();
  if (KNOWN_DEVELOPMENT_SECRETS.has(normalized) || PLACEHOLDER.test(secret)) {
    return `the session secret is a known development value or a placeholder ("${secret.length > 40 ? `${secret.slice(0, 12)}...` : secret}"): anyone who has read the repository can sign a login with it. ${how}`;
  }
  if (secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    return `the session secret is ${secret.length} characters; production needs at least ${MIN_PRODUCTION_SECRET_LENGTH}. ${how}`;
  }
  return null;
}

/**
 * Throws, with the reason, when this is a production server (`NODE_ENV=production`) whose session secret is missing or weak. Development
 * and test are never affected (the e2e and unit suites use short secrets on purpose).
 */
export function assertProductionAuthSecret(env: Env = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const problem = productionSecretProblem(resolveAuthSecret(env));
  if (problem) throw new Error(`Refusing to start in production: ${problem}`);
}
