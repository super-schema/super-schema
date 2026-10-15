// src/types/action-result.ts
/**
 * Server action result (client-safe). `details` carries a ServiceError's structured
 * payload — validation problems, publish blockers — so forms can render them.
 */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string; details?: object };
