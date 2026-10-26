import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * How many times a SERIALIZABLE transaction that lost a race is run again before the failure is reported. Each round the loser re-reads the
 * rows the winner wrote, so a decision that depended on them (the last administrator, a grant judged against the granter's roles) is taken
 * again on the new truth; five rounds is far more than two or three administrators racing ever need.
 */
export const SERIALIZABLE_ATTEMPTS = 5;

/**
 * Is `error` the database saying "this transaction lost a race with another" (PostgreSQL SQLSTATE 40001, or 40P01 for a deadlock)? Prisma
 * reports it as `P2034`; the embedded PGlite adapter maps 40001 to the same code, and a driver error that escaped the mapping still carries the
 * state or its text. Anything else is a real failure and is never retried.
 */
export function isSerializationFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, meta, message } = error as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown };
  if (code === "P2034" || code === "40001" || code === "40P01") return true;
  if (meta && (meta.code === "40001" || meta.code === "40P01")) return true;
  return typeof message === "string" && /could not serialize access|deadlock detected/i.test(message);
}

/**
 * Run `work` in ONE transaction at the SERIALIZABLE isolation level, running it again (a fresh transaction) when the database aborts it for
 * losing a race. For a read-then-write whose rule spans rows another request may change at the same moment: "never remove the last global
 * administrator" when two administrators remove each other. `work` must have no effect outside the transaction (it can run more than once).
 */
export async function runSerializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, attempts: number = SERIALIZABLE_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (e: unknown) {
      if (attempt >= attempts || !isSerializationFailure(e)) throw e;
    }
  }
}
