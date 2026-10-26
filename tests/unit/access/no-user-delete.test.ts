// @vitest-environment node
/**
 * Accounts are never deleted (access-control design, decision 13 and Task 4 ruling c). Audit rows point at their user (`audit_log_userId_fkey`) and are
 * immutable, so a user who has done anything cannot be removed; a person who must lose access is DISABLED (`setUserDisabled`), which stops them at sign-in and
 * on the next request. This scan fails for any code in `src` or `scripts` that deletes a user row: a Prisma `user.delete` / `user.deleteMany`, or SQL
 * `DELETE FROM users`. (Tests and the e2e harness clean up their own fixtures through the database directly; they are not product code.)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../../helpers/access-scan";

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** `prisma.user.delete(`, `tx.user.deleteMany(`, `db.user.delete(` ... and SQL that deletes from the users table. */
const USER_DELETE = [/\.user\s*\.\s*delete(Many)?\s*\(/, /\bDELETE\s+FROM\s+"?users"?\b/i, /\bTRUNCATE\s+(TABLE\s+)?"?users"?\b/i];

const deletesUsers = (text: string): number[] =>
  text
    .split("\n")
    .flatMap((line, index) => (!isComment(line) && USER_DELETE.some((pattern) => pattern.test(line)) ? [index + 1] : []));

describe("no code deletes a user", () => {
  const files = [...listSourceFiles("src", /\.(ts|tsx|mjs|js)$/), ...listSourceFiles("scripts", /\.(ts|tsx|mjs|js)$/)].filter((file) => !file.includes("/generated/"));

  it("the scan reads the source (it is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain("src/services/user.service.ts");
  });

  it("finds no user deletion in src or scripts", () => {
    const found = files.flatMap((file) => deletesUsers(readFileSync(file, "utf8")).map((line) => `${file}:${line}`));
    expect(found).toEqual([]);
  });

  it("the migrations that exist never delete users either (only the rollback of access_control clears a disabled user's password hash)", () => {
    const migrations = listSourceFiles("prisma/migrations", /\.sql$/);
    expect(migrations.length).toBeGreaterThan(20);
    const found = migrations.flatMap((file) => {
      const lines = readFileSync(file, "utf8").split("\n");
      return lines.flatMap((line, index) => (!/^\s*--/.test(line) && /\bDELETE\s+FROM\s+"?users"?\b/i.test(line) ? [`${file}:${index + 1}`] : []));
    });
    expect(found).toEqual([]);
  });

  it("the patterns see a deletion (self-test)", () => {
    expect(deletesUsers("await prisma.user.delete({ where: { id } });")).toEqual([1]);
    expect(deletesUsers("x\nawait tx.user.deleteMany();")).toEqual([2]);
    expect(deletesUsers('await db.$executeRaw`DELETE FROM "users" WHERE id = ${id}`;')).toEqual([1]);
    expect(deletesUsers("await db.$executeRawUnsafe('TRUNCATE TABLE users');")).toEqual([1]);
    expect(deletesUsers("// await prisma.user.delete({ where: { id } });")).toEqual([]);
    expect(deletesUsers("await prisma.userRole.deleteMany();")).toEqual([]);
    expect(deletesUsers("await prisma.user.update({ where: { id }, data: { disabledAt: now } });")).toEqual([]);
  });
});
