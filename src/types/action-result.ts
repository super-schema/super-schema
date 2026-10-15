// src/types/action-result.ts
/**
 * Server action result (client-safe). `details` carries a ServiceError's structured
 * payload — validation problems, publish blockers — so forms can render them;
 * `suggestedFix` is the service's one-line remedy, shown under the error.
 */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string; details?: object; suggestedFix?: string };
