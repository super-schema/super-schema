/**
 * A bounded, per-process wait for password sign-ins and registrations that come without a client address (`AUTH_TRUST_PROXY` not exactly "1").
 *
 * Without a trusted proxy every request shares one address, `UNTRUSTED_IP`. A sign-in then has only the per-e-mail limit (5 failures in 15 minutes),
 * so a guesser who spreads attempts over many e-mail addresses is limited by nothing here; and registration has no e-mail limit at all. Locking the
 * shared address would let one anonymous client lock out every sign-in and every sign-up, so this module never refuses. It slows instead: once more
 * than `BACKOFF_FREE_FAILURES` of the counted attempts without an address have happened in this process within the window, each further sign-in or
 * registration without an address waits `BACKOFF_STEP_MS` per extra attempt, up to `BACKOFF_MAX_MS`. Nothing is refused and nothing is written, and
 * the wait holds the request only (no database connection, no CPU).
 *
 * What is counted: a sign-in that did not succeed, and every registration (it hashes a password, so each one is work, whether or not it creates an account).
 *
 * The trade-off, which docs/auth-ops.md states: while the count is above the free attempts, EVERY sign-in or registration without an address waits, a
 * correct password included, so an ordinary user signing in or signing up during a spread-out run is slowed by up to `BACKOFF_MAX_MS`. The count lives in
 * memory: each instance keeps its own, so N instances allow about N times the guesses. The real answer to guessing across accounts is a limit at the
 * proxy, or `AUTH_TRUST_PROXY=1` behind one.
 */

/** The same 15 minutes as the sign-in throttle (`THROTTLE_WINDOW_MS`), kept here so that this module loads without the database. */
export const BACKOFF_WINDOW_MS = 15 * 60 * 1000;
/** Failed sign-ins without an address in the window before any wait. */
export const BACKOFF_FREE_FAILURES = 20;
/** The wait added for each failure beyond the free ones. */
export const BACKOFF_STEP_MS = 100;
/** The longest wait one sign-in takes. */
export const BACKOFF_MAX_MS = 2_000;
/** Failures kept in memory. More cannot change the wait (it is capped), and the memory stays bounded under a flood. */
const MAX_TRACKED = 10_000;

/** When (epoch ms) each counted failure of this process happened, oldest first. */
const failures: number[] = [];

function forgetBefore(now: number): void {
  let expired = 0;
  while (expired < failures.length && failures[expired] <= now - BACKOFF_WINDOW_MS) expired += 1;
  if (expired > 0) failures.splice(0, expired);
}

/** The wait, in ms, a sign-in without a client address takes now: 0 up to `BACKOFF_FREE_FAILURES` failures in the window, then growing, capped. */
export function loginBackoffMs(now: number = Date.now()): number {
  forgetBefore(now);
  const beyond = failures.length - BACKOFF_FREE_FAILURES;
  return beyond <= 0 ? 0 : Math.min(BACKOFF_MAX_MS, beyond * BACKOFF_STEP_MS);
}

/**
 * Counts a sign-in without a client address that did not succeed (a wrong password, an unknown or locked e-mail, an empty form), and a registration
 * without one (every attempt).
 */
export function noteUnaddressedAttempt(now: number = Date.now()): void {
  forgetBefore(now);
  failures.push(now);
  if (failures.length > MAX_TRACKED) failures.splice(0, failures.length - MAX_TRACKED);
}

/** Waits `ms` milliseconds; a wait of 0 returns at once. */
export async function waitFor(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
