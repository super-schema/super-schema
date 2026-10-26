/**
 * What the public server actions (register, accept an invitation, use a reset link) share: the client address of THIS request, the throttle
 * question, and recording an event without letting a problem with the log change the answer.
 *
 * Server only (it reads the request's headers).
 */
import { headers } from "next/headers";
import { clientIp, isThrottled, recordAuthEvent, type AuthEventKind, type AuthEventOutcome, type ThrottleKind } from "@/lib/auth/throttle";

/** The client address bucket of the request being served (`clientIp`: a trusted proxy header, else the constant bucket). */
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

/** Records an event; a failure to record is logged and never replaces the answer the visitor is about to get. */
export async function recordQuietly(kind: AuthEventKind, event: { email?: string; ip?: string; outcome: AuthEventOutcome }): Promise<void> {
  try {
    await recordAuthEvent(kind, event);
  } catch (error) {
    console.error(`[auth] could not record a ${kind} ${event.outcome} event`, error);
  }
}
