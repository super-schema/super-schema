import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const MIGRATION = "20261115000000_classification_class_number";
const ROW = (id: string, name: string, system: boolean, extra = "") =>
  `INSERT INTO "classification_levels" ("id","name","displayColor","bgColor","textColor","isSystem"${extra ? ',"classNumber"' : ""},"updatedAt") VALUES ('${id}','${name}','#000000','#00000020','#000000',${system}${extra ? "," + extra : ""},CURRENT_TIMESTAMP)`;

describe("classification_levels.classNumber on PGlite", () => {
  it("defaults a custom row to class 3", async () => {
    const db = new PGlite();
    try {
      expect(await applyPgliteMigrations(db)).toContain(MIGRATION);
      await db.exec(ROW("c1", "CONFIDENTIAL", false));
      const r = await db.query<{ classNumber: number }>(`SELECT "classNumber" FROM "classification_levels" WHERE "name" = 'CONFIDENTIAL'`);
      expect(r.rows[0].classNumber).toBe(3);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("the migration's UPDATEs set system rows by name (PII=2, SENSITIVE=3, INTERNAL=4, PUBLIC=5)", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      for (const [i, n] of ["PII", "SENSITIVE", "INTERNAL", "PUBLIC"].entries()) await db.exec(ROW(`s${i}`, n, true));
      const sql = readFileSync(`prisma/migrations/${MIGRATION}/migration.sql`, "utf8");
      const updates = sql.split("\n").filter((l) => l.startsWith("UPDATE"));
      expect(updates).toHaveLength(4);
      await db.exec(updates.join("\n"));
      const r = await db.query<{ name: string; classNumber: number }>(`SELECT "name","classNumber" FROM "classification_levels" ORDER BY "name"`);
      expect(Object.fromEntries(r.rows.map((x) => [x.name, x.classNumber]))).toEqual({ INTERNAL: 4, PII: 2, PUBLIC: 5, SENSITIVE: 3 });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("rejects a class outside 1-5", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await expect(db.exec(ROW("x", "X", false, "6"))).rejects.toThrow(/check/i);
      await expect(db.exec(ROW("y", "Y", false, "0"))).rejects.toThrow(/check/i);
    } finally {
      await db.close();
    }
  }, 60_000);
});
