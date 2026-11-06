/**
 * src/lib/pglite-open.ts: (D2) the data directory is created with its parents (PGlite's own mkdir is not recursive, so a fresh checkout without
 * ./data crashed `db ensure`); (D3) an unopenable directory fails with the way out instead of a bare `Aborted()`, `db:reset` moves it aside
 * (never deletes it) and the app and the scripts share one client per directory per process (a second one on the same directory aborts).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PGLITE_POSTGRES_MAJOR } from "@/lib/pglite-data-version";
import { PGlite } from "@electric-sql/pglite";
import { PgliteOpenError, closeSharedPglite, ensurePgliteDataDir, openPglite, resetPgliteDataDir, sharedPglite } from "../../../src/lib/pglite-open";

const tmp = () => mkdtempSync(path.join(tmpdir(), "pglite-open-"));
const open: PGlite[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close().catch(() => undefined)));
});

describe("ensurePgliteDataDir", () => {
  it("creates the directory with its missing parents, and is a no-op when it exists", () => {
    const dir = path.join(tmp(), "data", "nested", "pglite");
    ensurePgliteDataDir(dir);
    expect(existsSync(dir)).toBe(true);
    expect(() => ensurePgliteDataDir(dir)).not.toThrow();
  });

  it("leaves in-memory and browser locations alone", () => {
    const before = readdirSync(process.cwd()).length;
    ensurePgliteDataDir("memory://");
    ensurePgliteDataDir("idb://x");
    expect(readdirSync(process.cwd()).length).toBe(before);
  });
});

// Starting PGlite (WASM) takes several seconds when the whole suite runs in parallel: the 5 s default is too short there.
describe("openPglite", { timeout: 60_000 }, () => {
  it("opens (and creates) a directory whose parent does not exist yet", async () => {
    const db = await openPglite(path.join(tmp(), "a", "b"));
    open.push(db);
    expect((await db.query<{ n: number }>("select 1 as n")).rows[0].n).toBe(1);
  });

  it("fails an unopenable directory with db:reset named in the message", async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, "global"), { recursive: true });
    writeFileSync(path.join(dir, "PG_VERSION"), `${PGLITE_POSTGRES_MAJOR}\n`);
    writeFileSync(path.join(dir, "global", "pg_control"), "not a control file");
    const error = await openPglite(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PgliteOpenError);
    expect((error as Error).message).toContain("npm run db:reset");
    expect((error as Error).message).toContain(dir);
  }, 60_000);
});

describe("resetPgliteDataDir", { timeout: 60_000 }, () => {
  it("refuses a directory that opens fine unless forced, and moves it aside (not away) when forced", async () => {
    const dir = path.join(tmp(), "pg");
    const db = await openPglite(dir);
    await db.close();
    const refused = await resetPgliteDataDir(dir, { now: () => 1 });
    expect(refused.moved).toBe(false);
    expect(existsSync(dir)).toBe(true);
    const done = await resetPgliteDataDir(dir, { force: true, now: () => 7 });
    expect(done.moved).toBe(true);
    expect(done.backup).toBe(`${dir}.corrupt-7`);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.corrupt-7`)).toBe(true);
  }, 60_000);

  it("does nothing for a directory that does not exist", async () => {
    expect((await resetPgliteDataDir(path.join(tmp(), "none"))).moved).toBe(false);
  });
});

describe("sharedPglite", { timeout: 60_000 }, () => {
  it("returns one client per directory, however often it is asked, and a new one per other directory", () => {
    const a = path.join(tmp(), "a");
    const created: string[] = [];
    const make = (dir: string) => () => {
      created.push(dir);
      return { dir, close: async () => undefined } as unknown as PGlite;
    };
    const first = sharedPglite(a, make(a));
    expect(sharedPglite(a, make(a))).toBe(first);
    const b = path.join(tmp(), "b");
    expect(sharedPglite(b, make(b))).not.toBe(first);
    expect(created).toEqual([a, b]);
  });
});

describe("closeSharedPglite", () => {
  it("closes every shared client once and forgets them, so a script can exit", async () => {
    const dir = path.join(tmp(), "c");
    let closed = 0;
    const fake = { close: async () => { closed += 1; } } as unknown as PGlite;
    const client = sharedPglite(dir, () => fake);
    await closeSharedPglite();
    await closeSharedPglite();
    expect(closed).toBe(1);
    expect(sharedPglite(dir, () => ({ again: true }) as unknown as PGlite)).not.toBe(client);
  });
});
