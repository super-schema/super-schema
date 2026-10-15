/** `EventSpecVersion.major` / `.minor` are Postgres `integer`: anything larger cannot exist and would make the driver throw. */
const MAX_VERSION_PART = 2_147_483_647;
const VERSION_PARAM = /^v?(\d{1,10})\.(\d{1,10})$/;

/**
 * `MAJOR.MINOR` (optionally `v`-prefixed) as numbers, or null. Bounded on purpose: a 400-digit or out-of-range label must be a plain
 * rejection decided before any database read, not a driver error (a 500 that also tells a prober which spec ids exist). Versions
 * start at 1.0. Pure and client-safe: the page loader and the emit action share it.
 */
export function parseVersionParam(raw: unknown): { major: number; minor: number } | null {
  if (typeof raw !== "string") return null;
  const match = VERSION_PARAM.exec(raw);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 1 && major <= MAX_VERSION_PART && minor <= MAX_VERSION_PART ? { major, minor } : null;
}
