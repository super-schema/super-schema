// @vitest-environment node
/**
 * `runSerializable`: one SERIALIZABLE transaction, run again (a fresh one) when the database aborts it for losing a race, never retried for
 * any other failure, and given up after a bounded number of rounds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: mocks.$transaction } }));

import { SERIALIZABLE_ATTEMPTS, isSerializationFailure, runSerializable } from "@/lib/serializable-transaction";

const conflict = () => Object.assign(new Error("Transaction failed due to a write conflict or a deadlock. Please retry your transaction"), { code: "P2034" });

beforeEach(() => {
  mocks.$transaction.mockReset();
});

describe("isSerializationFailure", () => {
  it("recognizes the codes and texts of a lost race, and nothing else", () => {
    expect(isSerializationFailure(conflict())).toBe(true);
    expect(isSerializationFailure({ code: "40001" })).toBe(true);
    expect(isSerializationFailure({ code: "40P01" })).toBe(true);
    expect(isSerializationFailure({ code: "P2010", meta: { code: "40001" } })).toBe(true);
    expect(isSerializationFailure(new Error("ERROR: could not serialize access due to read/write dependencies among transactions"))).toBe(true);
    expect(isSerializationFailure(new Error("deadlock detected"))).toBe(true);
    for (const other of [new Error("boom"), { code: "P2002" }, { code: "P2025" }, null, undefined, "40001", 7]) expect(isSerializationFailure(other)).toBe(false);
  });
});

describe("runSerializable", () => {
  it("runs the work in ONE transaction at the SERIALIZABLE level and returns its result", async () => {
    mocks.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work("tx"));
    const work = vi.fn(async (tx: unknown) => ({ tx }));
    expect(await runSerializable(work)).toEqual({ tx: "tx" });
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.$transaction).toHaveBeenCalledWith(work, { isolationLevel: "Serializable" });
  });

  it("runs it again, in a fresh transaction, when the database aborts the first for losing a race", async () => {
    let round = 0;
    mocks.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => {
      round++;
      if (round < 3) throw conflict();
      return work("tx");
    });
    const work = vi.fn(async () => "decided on the new truth");
    expect(await runSerializable(work)).toBe("decided on the new truth");
    expect(mocks.$transaction).toHaveBeenCalledTimes(3);
  });

  it("gives up after a bounded number of rounds, with the database's own error", async () => {
    mocks.$transaction.mockRejectedValue(conflict());
    await expect(runSerializable(async () => "never")).rejects.toMatchObject({ code: "P2034" });
    expect(mocks.$transaction).toHaveBeenCalledTimes(SERIALIZABLE_ATTEMPTS);
  });

  it("does not retry any other failure", async () => {
    mocks.$transaction.mockRejectedValue(Object.assign(new Error("unique constraint"), { code: "P2002" }));
    await expect(runSerializable(async () => "never")).rejects.toMatchObject({ code: "P2002" });
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
  });
});
