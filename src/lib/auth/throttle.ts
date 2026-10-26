/**
 * Throttling and lockout for sign-in, registration, accepting an invitation and using a reset link (access-control design, decision 9).
 *
 * The state is rows of `auth_events` in the database, so it holds across several instances of the app and survives a restart. A row says
 * "this kind of event, with this outcome, at this time, for the e-mail with this hash and the client with this hash" and nothing more: the
 * hashes are HMAC-SHA-256 keyed with the auth secret (`hashEmail`, `hashIp`), so a copy of the table does not list who tried to sign in, and
 * cannot be turned back into addresses by hashing a list of them without the secret.
 *
 * The rules:
 *   - sign-in (`login`): 5 FAILURES in 15 minutes lock an e-mail (by hash) and, independently, a client address (by hash). A success resets the
 *     e-mail's count (failures before it are not counted), not the address's. An unknown e-mail is counted and locked like a known one: the state
 *     is by hash, so nothing here can tell them apart. A password attempt takes its place BEFORE its password is compared (`reserveLoginAttempt`: a
 *     `pending` row that counts as a failure until it is settled), so attempts made at the same moment cannot all pass the check.
 *   - registration (`register`): every ATTEMPT counts against the client address (5 in 15 minutes): a success creates an account, which is
 *     what is being limited.
 *   - accepting an invitation (`invite_accept`) and using a reset link (`reset_consume`): 5 FAILURES in 15 minutes per client address.
 *   - a sign-in through an identity provider that the policy REFUSED (`provider_refused:<reason>`, outcome `refused`: src/lib/auth/provider-callback.ts)
 *     counts, whatever the reason, against the client address (5 in 15 minutes; the shared bucket's ceiling when no proxy is trusted). The reason is the tail
 *     of the event kind, so a count of the table says what is being refused and the user is told none of it. The e-mail is not limited: a refusal there
 *     means the identity provider vouched for the person already, and the address is not a secret a guess can find.
 *   - an attempt made while locked is recorded as `locked` and does not count, so the lock is not extended by the attempts it refuses.
 *
 * The client address comes from `X-Forwarded-For` ONLY when `AUTH_TRUST_PROXY=1` (a proxy in front sets it; otherwise it is whatever the client
 * writes, and trusting it would let anyone choose their own bucket). Without trust every request is in one constant bucket, `UNTRUSTED_IP`, which
 * cannot tell clients apart: five typos by five people must not lock everybody out, so that bucket's ceiling is 100 failures, and the per-e-mail
 * limit (5) is the real protection. The left-most entry is taken, which is right when the proxy overwrites the header and only then (docs/auth-ops.md).
 *
 * What the caller shows a locked visitor is the answer for a wrong password (the same words, the same shape): `isThrottled` reports
 * `retryAfterSeconds` for the logs and for a caller that chooses to use it; nobody is told "locked".
 */
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { prisma } from "@/lib/db";
import { resolveAuthSecret } from "@/lib/auth-secret";
import { normalizeEmail } from "@/lib/auth/password-policy";

/** The kinds that have a rule of their own (`isThrottled` is asked about one of these). */
export type ThrottleKind = "login" | "register" | "invite_accept" | "reset_consume" | "provider_refused";
/** A refused provider sign-in carries its reason in the kind: `provider_refused:no-account`, `provider_refused:domain`, ... (`ProviderSignInRefusal`, plus `throttled`). */
export type ProviderRefusedKind = `provider_refused:${string}`;
/** What `recordAuthEvent` accepts: the throttled kinds, a refused provider sign-in with its reason, and a successful one. */
export type AuthEventKind = Exclude<ThrottleKind, "provider_refused"> | ProviderRefusedKind | "provider_login";
/**
 * `success` / `failure` of a sign-in or token use, `attempt` of a registration, `refused` for a provider sign-in the policy refused, `locked` for an
 * attempt that was refused because of the limit, `pending` for a password sign-in that has reserved its place and is not decided yet (`reserveLoginAttempt`).
 */
export type AuthEventOutcome = "success" | "failure" | "attempt" | "refused" | "locked" | "pending";

export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const THROTTLE_MAX_FAILURES = 5;
/** The bucket of every request when no proxy is trusted (see the header). */
export const UNTRUSTED_IP = "untrusted";
/** The ceiling of the shared bucket: 20 times a single client's, so it stops a flood and not a bad afternoon. */
export const UNTRUSTED_IP_MAX_FAILURES = THROTTLE_MAX_FAILURES * 20;
/** Rows older than this are deleted by the next inserts. */
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
/** At most this many old rows are deleted by one insert (a backlog is worked off over the following ones, no insert becomes a big delete). */
export const PRUNE_BATCH = 200;

/** Which outcomes of each kind count toward its limit, and whether a success of it resets an e-mail's count. */
const COUNTED: Record<ThrottleKind, { outcomes: AuthEventOutcome[]; successResets: boolean; kindPrefix?: string }> = {
  // an attempt still being decided counts like a failure: it has not been shown to be anything else
  login: { outcomes: ["failure", "pending"], successResets: true },
  register: { outcomes: ["attempt"], successResets: false },
  invite_accept: { outcomes: ["failure"], successResets: false },
  reset_consume: { outcomes: ["failure"], successResets: false },
  // every reason counts: the rows of this family are `provider_refused:<reason>`
  provider_refused: { outcomes: ["refused"], successResets: false, kindPrefix: "provider_refused:" },
};

function keyedDigest(label: "email" | "ip", value: string): string {
  const secret = resolveAuthSecret();
  if (!secret) throw new Error("Cannot hash for throttling: no AUTH_SECRET / NEXTAUTH_SECRET is set.");
  // The label keeps the two kinds of value apart: an e-mail and an address that spell the same never share a digest.
  return createHmac("sha256", secret).update(`${label}\u0000${value}`).digest("hex");
}

/** The stored form of an e-mail address: HMAC-SHA-256 (hex), keyed with the auth secret, of the normalized address. */
export const hashEmail = (email: string): string => keyedDigest("email", normalizeEmail(email));
/** The stored form of a client address (or of `UNTRUSTED_IP`): HMAC-SHA-256 (hex), keyed with the auth secret. */
export const hashIp = (ip: string): string => keyedDigest("ip", ip);

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
 * client arrives as 127.0.0.1 / ::1, which tells clients apart no better than no header at all (the shared bucket, with the shared ceiling).
 */
export function clientIp(headers: { get(name: string): string | null }, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.AUTH_TRUST_PROXY !== "1") return UNTRUSTED_IP;
  const first = (headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  if (first === "" || isIP(first) === 0 || isLoopback(first)) return UNTRUSTED_IP;
  return first.toLowerCase();
}

/** Inserts one event (and prunes old rows in the same transaction) and returns its id. */
async function insertEvent(kind: AuthEventKind, event: { email?: string; ip?: string; outcome: AuthEventOutcome }, now: Date): Promise<string> {
  const emailHash = event.email !== undefined ? hashEmail(event.email) : null;
  const ipHash = event.ip !== undefined ? hashIp(event.ip) : null;
  const cutoff = new Date(now.getTime() - PRUNE_AFTER_MS);
  return prisma.$transaction(async (tx) => {
    const old = await tx.authEvent.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: PRUNE_BATCH });
    if (old.length > 0) await tx.authEvent.deleteMany({ where: { id: { in: old.map((row) => row.id) } } });
    const row = await tx.authEvent.create({ data: { kind, emailHash, ipHash, outcome: event.outcome, createdAt: now }, select: { id: true } });
    return row.id;
  });
}

/**
 * Records one event. Rows older than 24 hours are deleted in the same transaction (a bounded batch), so the table cleans itself where it is
 * written and nothing needs a scheduler. Throws on a database failure: the caller decides whether that blocks (for a failure it must not be
 * lost silently; for a success it must not block a sign-in).
 *
 * @param now the event's time (and the pruning's reference); the clock unless a test sets it
 */
export async function recordAuthEvent(
  kind: AuthEventKind,
  event: { email?: string; ip?: string; outcome: AuthEventOutcome },
  now: Date = new Date(),
): Promise<void> {
  await insertEvent(kind, event, now);
}

type Dimension = { field: "emailHash" | "ipHash"; hash: string; limit: number };

/** How many seconds until the count of this dimension falls below `threshold`: when enough of the oldest counted rows have left the window. */
async function secondsUntilBelowThreshold(where: object, count: number, threshold: number, now: Date): Promise<number> {
  const [expiring] = await prisma.authEvent.findMany({ where, orderBy: { createdAt: "asc" }, skip: count - threshold, take: 1, select: { createdAt: true } });
  if (!expiring) return 1;
  return Math.max(1, Math.ceil((expiring.createdAt.getTime() + THROTTLE_WINDOW_MS - now.getTime()) / 1000));
}

/**
 * The seconds each locked dimension still has to wait (empty: not locked). A dimension is locked at `limit` counted rows, or, when the caller's own
 * reserved row is among the counted ones (`ownReserved`), at `limit + 1`: the caller is the (limit)th attempt that is let through, not the one after it.
 */
async function lockWaits(input: { email?: string; ip?: string }, kind: ThrottleKind, now: Date, ownReserved: boolean): Promise<number[]> {
  const rule = COUNTED[kind];
  const windowStart = new Date(now.getTime() - THROTTLE_WINDOW_MS);

  const dimensions: Dimension[] = [];
  if (input.email !== undefined) dimensions.push({ field: "emailHash", hash: hashEmail(input.email), limit: THROTTLE_MAX_FAILURES });
  if (input.ip !== undefined) {
    dimensions.push({ field: "ipHash", hash: hashIp(input.ip), limit: input.ip === UNTRUSTED_IP ? UNTRUSTED_IP_MAX_FAILURES : THROTTLE_MAX_FAILURES });
  }

  const waits = await Promise.all(
    dimensions.map(async (dimension): Promise<number | null> => {
      let since = windowStart;
      if (dimension.field === "emailHash" && rule.successResets) {
        const lastSuccess = await prisma.authEvent.findFirst({
          where: { emailHash: dimension.hash, kind, outcome: "success", createdAt: { gt: windowStart } },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        if (lastSuccess) since = lastSuccess.createdAt;
      }
      const where = { [dimension.field]: dimension.hash, kind: rule.kindPrefix ? { startsWith: rule.kindPrefix } : kind, outcome: { in: rule.outcomes }, createdAt: { gt: since } };
      // A success that reserved AFTER this caller moved `since` past the caller's own row: that row is still the caller's attempt, so it is counted by hand.
      const ownOutsideWindow = ownReserved && now.getTime() <= since.getTime();
      const count = (await prisma.authEvent.count({ where })) + (ownOutsideWindow ? 1 : 0);
      const threshold = dimension.limit + (ownReserved ? 1 : 0);
      if (count < threshold) return null;
      return secondsUntilBelowThreshold(where, count, threshold, now);
    }),
  );
  return waits.filter((wait): wait is number => wait !== null);
}

/**
 * Is this visitor locked out? Asks about each dimension it is given: the e-mail (by hash; for kinds where a success resets it, only the failures
 * after the last success count) and the client address (by hash). Locked when either is at or over its limit. `retryAfterSeconds` is when the
 * later of the locks lifts.
 *
 * @param kind which endpoint (default `login`)
 * @param now the clock unless a test sets it
 */
export async function isThrottled(
  input: { email?: string; ip?: string; kind?: ThrottleKind },
  now: Date = new Date(),
): Promise<{ throttled: boolean; retryAfterSeconds?: number }> {
  const locked = await lockWaits(input, input.kind ?? "login", now, false);
  return locked.length === 0 ? { throttled: false } : { throttled: true, retryAfterSeconds: Math.max(...locked) };
}

/** A password sign-in's place in the count: `id` settles it (`settleAuthEvent`), `locked` says the attempt must be refused. */
export type LoginReservation = { id: string; locked: boolean; retryAfterSeconds?: number };

/**
 * Asks "may this password be tried?" AND takes the place in one move, so attempts made at the same moment cannot all pass the check: a `pending` row
 * is written FIRST and the count includes it, so of any number of simultaneous attempts at most `limit` are let through (the last of them to count
 * sees every other one's row). Reading the count before the compare and writing the failure after it would let every one of them pass.
 *
 * The row counts as a failure until it is settled. A caller that never settles it (a crash between here and the compare) leaves it counted for the
 * rest of the window, which is the safe side. Attempts made at the very same moment can refuse each other (each counts the other's row); the
 * refused ones settle as `locked` and stop counting, so the next attempt is judged on what was really tried.
 *
 * Throws on a database failure; the caller fails closed (a throttle that cannot be read or written refuses).
 */
export async function reserveLoginAttempt(input: { email: string; ip: string }, now: Date = new Date()): Promise<LoginReservation> {
  const id = await insertEvent("login", { email: input.email, ip: input.ip, outcome: "pending" }, now);
  const waits = await lockWaits(input, "login", now, true);
  return waits.length === 0 ? { id, locked: false } : { id, locked: true, retryAfterSeconds: Math.max(...waits) };
}

/** Settles a reserved attempt: `success` (resets the e-mail's count), `failure` (stays counted) or `locked` (refused: stops counting). */
export async function settleAuthEvent(id: string, outcome: Extract<AuthEventOutcome, "success" | "failure" | "locked">): Promise<void> {
  await prisma.authEvent.update({ where: { id }, data: { outcome } });
}
