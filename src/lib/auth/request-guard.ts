/**
 * What the public server actions (register, accept an invitation, use a reset link) share: the client address of THIS request, the throttle
 * question, and recording an event without letting a problem with the log change the answer.
 *
 * Server only (it reads the request's headers).
 */
import { headers } from "next/headers";
import {
  clientIp,
  isThrottled,
  recordAuthEvent,
  reserveCountedAttempt,
  settleAuthEvent,
  type AuthEventKind,
  type AuthEventOutcome,
  type ThrottleKind,
} from "@/lib/auth/throttle";

/** The client address of the request being served (`clientIp`: a trusted proxy's header, else `UNTRUSTED_IP`, which no kind counts: throttle.ts). */
export async function requestIp(): Promise<string> {
  return clientIp(await headers());
}

/**
 * Is this address locked out of `kind`? A locked attempt is written down as `locked` (it does not count toward the limit, so refusing it does not
 * extend the lock). Fails CLOSED: when the throttle itself cannot be read the attempt is refused, because a database that cannot answer this
 * question is not a reason to let an unlimited number of guesses through.
 */
export async function isBlocked(kind: Exclude<ThrottleKind, "provider_refused">, ip: string): Promise<boolean> {
  try {
    const { throttled } = await isThrottled({ ip, kind });
    if (throttled) await recordQuietly(kind, { ip, outcome: "locked" });
    return throttled;
  } catch (error) {
    console.error(`[auth] could not read the ${kind} throttle; refusing the attempt`, error);
    return true;
  }
}

/**
 * Takes this address's place in `kind` BEFORE the work is done, and says whether the attempt is refused (true). For a kind in which every attempt counts
 * (`register`), asking first and recording afterwards lets any number of simultaneous attempts all pass the question: the row is written first and counted
 * with the others (`reserveCountedAttempt`). A refused attempt stops counting, so refusing does not extend the lock. Fails CLOSED, like `isBlocked`.
 */
export async function reserveAttempt(kind: Extract<ThrottleKind, "register">, ip: string): Promise<boolean> {
  try {
    const reservation = await reserveCountedAttempt(kind, { ip });
    if (reservation.locked) {
      try {
        await settleAuthEvent(reservation.id, "locked");
      } catch (error) {
        console.error(`[auth] could not settle a refused ${kind} attempt; it stays counted`, error);
      }
    }
    return reservation.locked;
  } catch (error) {
    console.error(`[auth] could not take a place in the ${kind} throttle; refusing the attempt`, error);
    return true;
  }
}

/** Records an event; a failure to record is logged and never replaces the answer the visitor is about to get. */
export async function recordQuietly(kind: AuthEventKind, event: { email?: string; ip?: string; outcome: AuthEventOutcome }): Promise<void> {
  try {
    await recordAuthEvent(kind, event);
  } catch (error) {
    console.error(`[auth] could not record a ${kind} ${event.outcome} event`, error);
  }
}
