// src/types/action-result.ts
/**
 * Server action result (client-safe). `details` carries a ServiceError's structured
 * payload — validation problems, publish blockers — so forms can render them;
 * `suggestedFix` is the service's one-line remedy, shown under the error.
 */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string; details?: object; suggestedFix?: string };

/** Shown in place of raw database / driver text (server-side `sanitizeActionError` and client forms share it). */
export const GENERIC_ACTION_ERROR = "Something went wrong. Try again; if it keeps happening, contact an administrator.";

/** Failure codes whose service message may carry raw database / driver text: never shown to the user. */
const OPAQUE_ERROR_CODES: readonly string[] = ["DB_ERROR", "INTERNAL_ERROR"];

/** True for failure codes whose message must never reach the user (see `OPAQUE_ERROR_CODES`). */
export function isOpaqueErrorCode(code: string | undefined): boolean {
  return code !== undefined && OPAQUE_ERROR_CODES.includes(code);
}

/**
 * The one line a form shows for a failed action result: the service's message plus its suggested fix,
 * except for `DB_ERROR` / `INTERNAL_ERROR`, which become the generic message (no fix either).
 */
export function actionErrorText(failure: { error: string; code?: string; suggestedFix?: string }): string {
  if (isOpaqueErrorCode(failure.code)) return GENERIC_ACTION_ERROR;
  return failure.suggestedFix ? `${failure.error} ${failure.suggestedFix}` : failure.error;
}
