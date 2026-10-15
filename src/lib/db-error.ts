// src/lib/db-error.ts
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import { err, type Result } from "@/types/result";

/**
 * A `DB_ERROR` failure Result that never carries driver text. Services that catch an unexpected database throw (lost
 * connection, Prisma validation / constraint text with table, column and host names) return this instead of building a
 * message from `e.message`: the original is logged server-side, `context` says where, and the Result holds only the generic
 * message, so it is safe to hand to REST routes and server actions alike (`toActionResult` still backstops it).
 */
export function dbErrorResult(context: string, cause: unknown): Result<never> {
  console.error(`[${context}] database error`, cause);
  return err({ code: "DB_ERROR", message: GENERIC_ACTION_ERROR });
}
