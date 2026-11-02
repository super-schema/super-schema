// tests/unit/lib/pglite-data-version.test.ts
// A PGlite data directory made by another PostgreSQL major (PGlite 0.4 = PostgreSQL 17) is refused before PGlite opens it, with the command
// that upgrades it; a new, current or non-filesystem directory is left to PGlite.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPgliteDataDirOpenable, PGLITE_POSTGRES_MAJOR, pgliteDataDirProblem, pgliteFilesystemDir } from "@/lib/pglite-data-version";

const made: string[] = [];
function dataDir(pgVersion?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pglite-version-"));
  made.push(dir);
  if (pgVersion !== undefined) writeFileSync(path.join(dir, "PG_VERSION"), `${pgVersion}\n`);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pgliteDataDirProblem", () => {
  it("names the upgrade command for a PostgreSQL 17 directory (PGlite 0.4)", () => {
    const dir = dataDir("17");
    const problem = pgliteDataDirProblem(dir);
    expect(problem).toContain(`made by PostgreSQL 17`);
    expect(problem).toContain(`embeds PostgreSQL ${PGLITE_POSTGRES_MAJOR}`);
    expect(problem).toContain("npm run db:pglite-upgrade");
    expect(() => assertPgliteDataDirOpenable(dir)).toThrow(/npm run db:pglite-upgrade/);
  });

  it("leaves a directory of the embedded major, a missing one and an empty one to PGlite", () => {
    expect(pgliteDataDirProblem(dataDir(PGLITE_POSTGRES_MAJOR))).toBeNull();
    expect(pgliteDataDirProblem(path.join(dataDir(), "not-made-yet"))).toBeNull();
    const empty = dataDir();
    mkdirSync(path.join(empty, "base"));
    expect(pgliteDataDirProblem(empty)).toBeNull();
    expect(assertPgliteDataDirOpenable(empty)).toBe(empty);
  });

  it("never looks at a directory that is not on disk", () => {
    for (const dataDir of ["memory://shadow", "idb://superschema", "opfs-ahp://superschema", "memfs2opfs://superschema", ""]) {
      expect(pgliteFilesystemDir(dataDir), dataDir).toBeNull();
      expect(pgliteDataDirProblem(dataDir), dataDir).toBeNull();
    }
  });

  it("checks a file:// directory as PGlite opens it (the scheme stripped), so a PostgreSQL 17 one is refused too", () => {
    const dir = dataDir("17");
    expect(pgliteFilesystemDir(`file://${dir}`)).toBe(dir);
    expect(pgliteDataDirProblem(`file://${dir}`)).toContain("npm run db:pglite-upgrade");
  });
});
