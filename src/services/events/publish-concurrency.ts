// src/services/events/publish-concurrency.ts

/**
 * Prisma codes that mean a concurrent writer (or lock contention) beat a publish transaction, so retrying the publish is
 * the right answer and a retryable CONFLICT the right report:
 * - P2002: unique version label / sequence taken by a concurrent publish.
 * - P2003: FK to a row a concurrent delete removed (`auditedWrite` would misreport it as IN_USE).
 * - P2034: write conflict / serialization failure (SQLSTATE 40001, mapped by the driver adapters).
 * - P2028: transaction API error: the interactive transaction expired or timed out (a lock wait outlived its timeout) or
 *   could not start in time.
 *
 * Deliberately NOT here: P2024 (connection pool exhausted: not caused by a concurrent writer, and "changed during publish"
 * would mislead) and plain statement timeouts (57014: any slow statement, not only a lock wait).
 */
const CONCURRENT_WRITE_CODES = new Set(["P2002", "P2003", "P2034", "P2028"]);

/**
 * SQLSTATEs of lock contention seen through raw lock statements. The publish lock statements are `$queryRaw ... FOR UPDATE /
 * FOR SHARE`, and Prisma reports a failed raw query as P2010 ("Raw query failed") with the database's own code, so a
 * deadlock or lock timeout there is NOT a P2034: 40P01 deadlock_detected, 55P03 lock_not_available (lock_timeout / NOWAIT)
 * and 40001 serialization_failure.
 */
const LOCK_CONTENTION_SQLSTATES = new Set(["40001", "40P01", "55P03"]);

const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined);

/**
 * The SQLSTATE behind a P2010 raw-query failure: `meta.driverAdapterError.cause.originalCode` with the driver adapters (the
 * app's setup, PostgreSQL and PGlite alike), `meta.code` with the classic query engine.
 */
function rawQuerySqlState(e: Record<string, unknown>): string | undefined {
  const meta = asRecord(e.meta);
  const fromAdapter = asRecord(asRecord(meta?.driverAdapterError)?.cause)?.originalCode;
  const state = typeof fromAdapter === "string" ? fromAdapter : meta?.code;
  return typeof state === "string" ? state : undefined;
}

/**
 * True when an error thrown out of a publish transaction means "something changed under the publish / the lock was lost":
 * see `CONCURRENT_WRITE_CODES` and `LOCK_CONTENTION_SQLSTATES`. A P2010 with any other SQLSTATE (missing table, bad SQL, …)
 * is a genuine database error and stays one.
 */
export function isConcurrentWriteFailure(e: unknown): boolean {
  const error = asRecord(e);
  const code = error?.code;
  if (!error || typeof code !== "string") return false;
  if (CONCURRENT_WRITE_CODES.has(code)) return true;
  if (code !== "P2010") return false;
  const state = rawQuerySqlState(error);
  return state !== undefined && LOCK_CONTENTION_SQLSTATES.has(state);
}
