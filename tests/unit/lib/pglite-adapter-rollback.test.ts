// tests/unit/lib/pglite-adapter-rollback.test.ts
// The vendored Prisma adapter's rollback when PGlite's ROLLBACK itself fails: the failure reaches the caller, nothing is committed, and the
// transaction callback is released (PGlite holds an exclusive lock until it returns, so a pending callback would wedge every later query).
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaPGliteAdapterFactory } from "@/lib/pglite-adapter/pglite";

const query = (sql: string) => ({ sql, args: [], argTypes: [] });

let pg: PGlite | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await pg?.close();
  pg = undefined;
});

describe("PrismaPGliteAdapter: a ROLLBACK that fails", () => {
  it("rejects, commits nothing, and leaves the database usable", async () => {
    pg = new PGlite("memory://");
    await pg.exec("CREATE TABLE t (n int)");

    // Every transaction PGlite hands out gets a rollback that fails once, the way a lost connection or a WASM error would.
    const original = pg.transaction.bind(pg);
    vi.spyOn(pg, "transaction").mockImplementation((callback) =>
      original((tx) => {
        let failNext = true;
        const failing = new Proxy(tx, {
          get(target, key, receiver) {
            if (key === "rollback" && failNext) {
              failNext = false;
              return async () => {
                throw new Error("rollback failed");
              };
            }
            return Reflect.get(target, key, receiver);
          },
        }) as Transaction;
        return callback(failing);
      }),
    );

    const adapter = await new PrismaPGliteAdapterFactory(pg).connect();
    const tx = await adapter.startTransaction();
    await tx.executeRaw(query("INSERT INTO t VALUES (1)"));
    await expect(tx.rollback()).rejects.toThrow("rollback failed");

    // Not committed (PGlite's error path rolled back instead), and not wedged: these would hang behind a pending callback.
    const count = await Promise.race([
      pg.query<{ n: number }>("SELECT count(*)::int AS n FROM t"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the database is wedged")), 5_000)),
    ]);
    expect(count.rows[0].n).toBe(0);
    const next = await adapter.startTransaction();
    await next.executeRaw(query("INSERT INTO t VALUES (2)"));
    await next.commit();
    expect((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM t")).rows[0].n).toBe(1);
  });
});
