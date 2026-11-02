/**
 * How many TypeSpec compiler runs one principal (a signed-in user, or the API key's service principal) may have in flight at once, queued or
 * running. One run per target: an emission of the eight schema targets takes eight units, a generation of one target takes one. An event's draft,
 * preview or publish takes one unit per render it starts (`eventRenderShare`, src/services/events/event-snapshot.ts), at most the whole share.
 *
 * The compiler's queue (src/lib/typespec-official/emitter.service.ts) is one for the whole process, so without this one caller's calls could fill
 * it and every other caller's run would be refused as busy (EMITTER_BUSY) for as long as they kept going. With it a principal holds at most
 * `RUNS_PER_PRINCIPAL` runs there, which is two full emissions: a call over that share is refused at once (429) and starts nothing. It is in
 * memory and per process, like the other limits of the REST API (KD-028).
 */
import { KeyedSlots } from "@/lib/concurrency/keyed-slots";
import type { ServiceError } from "@/types/result";

/** The compiler runs one principal may hold in flight (queued or running) in this process. */
export const RUNS_PER_PRINCIPAL = 16;

/** What a caller is told when the compiler's queue is full (`EMITTER_BUSY`): the REST 503 and the dashboard's answer. Nothing is wrong with the schema. */
export const COMPILER_BUSY_MESSAGE = "The TypeSpec compiler is busy with other runs. Try again in a moment.";

/** What a caller over its share is told (the REST 429 and the dashboard's refusal): nothing was built, so retrying later is the whole answer. */
export const SHARE_IN_USE_MESSAGE = "You already have schema generation running. Wait for it to finish, then try again.";

/** The same refusal as a service error: the REST answers it 429 (`apiCompilerSharesInUse`), an event service returns it to its caller. */
export const shareInUseError = (): ServiceError => ({
  code: "RATE_LIMITED",
  message: SHARE_IN_USE_MESSAGE,
  suggestedFix: "Wait for the running generation to finish, then send the request again.",
});

/** The same "try again" as a service error, for a service that gets a busy compiler back (`EMITTER_BUSY`): the REST routes answer 503 with `Retry-After`. */
export const compilerBusyError = (): ServiceError => ({ code: "EMITTER_BUSY", message: COMPILER_BUSY_MESSAGE });

const admission = new KeyedSlots(RUNS_PER_PRINCIPAL);

/**
 * Takes `runs` of the principal's share for an emission about to start. Returns the release (call it once the emission has settled, on every
 * path), or null when the share would be exceeded: then nothing was taken and the caller answers 429 without building anything.
 */
export function admitCompilerRuns(principalId: string, runs: number): (() => void) | null {
  return admission.tryAcquire(principalId, Math.max(1, runs));
}
