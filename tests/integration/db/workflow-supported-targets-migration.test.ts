import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
it("backfills supported targets without changing legacy workflow data", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE deployment_workflows (id TEXT PRIMARY KEY, format TEXT NOT NULL, settings JSONB, revision INTEGER); INSERT INTO deployment_workflows VALUES ('a','avro','{"subject":"account"}',4),('b','bigquery','{}',2);`);
    await pg.exec(readFileSync(new URL("../../../prisma/migrations/20261111000000_workflow_supported_targets/migration.sql", import.meta.url), "utf8"));
    expect((await pg.query('SELECT * FROM deployment_workflows ORDER BY id')).rows).toEqual([
      { id: "a", format: "avro", supportedTargets: ["avro"], settings: { subject: "account" }, revision: 4 },
      { id: "b", format: "bigquery", supportedTargets: ["bigquery"], settings: {}, revision: 2 },
    ]);
  } finally { await pg.close(); }
});
