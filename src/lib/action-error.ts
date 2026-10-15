// src/lib/action-error.ts
// Client-safe: no server imports, so `action-context.ts` (server) and the event editors (browser) share one definition.
import type { ActionResult } from "@/types/action-result";

export const GENERIC_ACTION_ERROR = "Something went wrong. Try again; if it keeps happening, contact an administrator.";

/** Failure codes whose service text may carry database / driver internals; a form never shows it. */
const SANITIZED_CODES: ReadonlySet<string> = new Set(["DB_ERROR", "INTERNAL_ERROR"]);

/** What a form shows under a failed save: the message, plus the service's one-line remedy when it has one. */
export interface ActionNotice {
  message: string;
  fix?: string;
}

/** Client-side backstop for server-side `sanitizeActionError`: DB_ERROR / INTERNAL_ERROR always render the generic text. */
export function noticeFor(failure: { error: string; code?: string; suggestedFix?: string }): ActionNotice {
  if (failure.code && SANITIZED_CODES.has(failure.code)) return { message: GENERIC_ACTION_ERROR };
  return { message: failure.error, ...(failure.suggestedFix && { fix: failure.suggestedFix }) };
}

/** Runs a server action; a rejection (network, serialization, an unwrapped server throw) becomes a generic failure instead of an unhandled promise. */
export async function settleAction<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (e: unknown) {
    console.error("[settleAction] action failed", e);
    return { success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" };
  }
}
