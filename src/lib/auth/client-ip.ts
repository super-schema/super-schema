/**
 * The client address of a request, for the limits that count by address: the sign-in throttle (src/lib/auth/throttle.ts) and the REST API's limit
 * on failed authentication (src/app/api/v1/rate-limit.ts). Pure: it reads no database, so the REST guard can use it without loading one.
 *
 * The address comes from `X-Forwarded-For` ONLY when `AUTH_TRUST_PROXY` is exactly "1" (a proxy in front sets it; otherwise it is whatever the client
 * writes, and trusting it would let anyone choose their own bucket). Without trust, and whenever the header gives no usable address, every request has
 * the one address `UNTRUSTED_IP`. That is not a client: each limit says whether it counts it (throttle.ts, rate-limit.ts).
 */
import { isIP } from "node:net";

/** The address of every request when no proxy is trusted (or the header gives no address). Not a client: see the header. */
export const UNTRUSTED_IP = "untrusted";

/** The loopback addresses: 127.0.0.0/8, ::1 (any spelling) and their IPv4-mapped form. */
function isLoopback(address: string): boolean {
  const mapped = address.replace(/^::ffff:/i, "");
  if (isIP(mapped) === 4) return mapped.startsWith("127.");
  return /^(0{0,4}:){1,7}0{0,3}1$/.test(address) || address === "::1";
}

/**
 * The client address of a request: the left-most entry of `X-Forwarded-For` when `AUTH_TRUST_PROXY` is exactly "1" and the entry is an IP
 * address, else `UNTRUSTED_IP`. A header that is missing, empty or garbage does not make a bucket of its own, and neither does a LOOPBACK
 * address: `next start` writes the socket's own address into the header when a request carries none, so with trust on and no proxy in front every
 * client arrives as 127.0.0.1 / ::1, which tells clients apart no better than no header at all.
 */
export function clientIp(headers: { get(name: string): string | null }, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.AUTH_TRUST_PROXY !== "1") return UNTRUSTED_IP;
  const first = (headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  if (first === "" || isIP(first) === 0 || isLoopback(first)) return UNTRUSTED_IP;
  return first.toLowerCase();
}

/**
 * What the server logs once when it starts in production without a trusted proxy (`AUTH_TRUST_PROXY` not exactly "1"): there is no client address,
 * so the limits that count by address count nothing of the kind, and password guesses spread over many e-mail addresses are only slowed in this app
 * (login-backoff.ts), never refused. It is a warning, not a refusal: a deployment may have a proxy that limits the sign-in itself. Null when there is nothing to say.
 */
export function trustProxyStartupWarning(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (env.NODE_ENV !== "production" || env.AUTH_TRUST_PROXY === "1") return null;
  return (
    "[auth] AUTH_TRUST_PROXY is not 1 in production: there is no client address. Sign-in, invitation, reset and provider limits count per e-mail " +
    "only, password guesses spread over many e-mail addresses are only slowed here (never refused), and open registrations are slowed the same way. " +
    "Limit /api/auth/* and /api/v1 at your reverse proxy, or set AUTH_TRUST_PROXY=1 behind a proxy that overwrites X-Forwarded-For. " +
    "See docs/auth-ops.md (Throttling)."
  );
}
