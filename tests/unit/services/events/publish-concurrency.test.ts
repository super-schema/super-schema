import { describe, it, expect } from "vitest";
import { isConcurrentWriteFailure } from "@/services/events/publish-concurrency";

/** A stand-in for PrismaClientKnownRequestError: duck-typed on `code` (and `meta`), like the real thing's fields. */
const prismaError = (code: string, meta?: object) => Object.assign(new Error(`prisma ${code}`), { code, ...(meta && { meta }) });
/** A failed `$queryRaw`: Prisma 7's driver-adapter shape (what the app runs on, PostgreSQL and PGlite alike). */
const rawQueryError = (sqlState: string) =>
  prismaError("P2010", { driverAdapterError: { name: "DriverAdapterError", message: "x", cause: { originalCode: sqlState, originalMessage: "x", kind: "postgres" } } });
/** The classic query-engine shape of the same failure. */
const classicRawQueryError = (sqlState: string) => prismaError("P2010", { code: sqlState, message: "x" });

describe("isConcurrentWriteFailure", () => {
  it.each([
    ["P2002", "unique version label / sequence"],
    ["P2003", "FK to a concurrently deleted row"],
    ["P2034", "write conflict / deadlock"],
    ["P2028", "transaction expired / timed out / could not start (lock wait outlived the transaction)"],
  ])("treats %s (%s) as a concurrent-write failure", (code) => {
    expect(isConcurrentWriteFailure(prismaError(code))).toBe(true);
  });

  it.each([
    ["40P01", "deadlock_detected"],
    ["55P03", "lock_not_available (lock_timeout / NOWAIT)"],
    ["40001", "serialization_failure"],
  ])("treats a raw-query P2010 failure with SQLSTATE %s (%s) as lock contention, in both error shapes", (state) => {
    expect(isConcurrentWriteFailure(rawQueryError(state))).toBe(true);
    expect(isConcurrentWriteFailure(classicRawQueryError(state))).toBe(true);
  });

  it("keeps genuine database errors out: a P2010 with any other SQLSTATE, other Prisma codes, plain errors and non-errors", () => {
    for (const state of ["42P01", "42601", "57014", "53300", "23505", "XX000"]) {
      expect(isConcurrentWriteFailure(rawQueryError(state))).toBe(false);
      expect(isConcurrentWriteFailure(classicRawQueryError(state))).toBe(false);
    }
    expect(isConcurrentWriteFailure(prismaError("P2010"))).toBe(false); // no meta at all
    expect(isConcurrentWriteFailure(prismaError("P2010", { driverAdapterError: {} }))).toBe(false);
    expect(isConcurrentWriteFailure(prismaError("P2010", { driverAdapterError: { cause: { originalCode: 40001 } } }))).toBe(false); // not a string
    for (const code of ["P2024", "P2025", "P2021", "P1001", "P1008", "40P01", "55P03", "ECONNRESET"]) {
      expect(isConcurrentWriteFailure(prismaError(code))).toBe(false);
    }
    expect(isConcurrentWriteFailure(new Error("deadlock detected"))).toBe(false);
    for (const value of [undefined, null, "P2034", 42, {}, { code: 2034 }, { code: undefined }]) {
      expect(isConcurrentWriteFailure(value)).toBe(false);
    }
  });

  it("does not read SQLSTATE from meta on a non-P2010 error (a P2025 that happens to carry one stays an error)", () => {
    expect(isConcurrentWriteFailure(prismaError("P2025", { code: "40P01" }))).toBe(false);
  });
});
