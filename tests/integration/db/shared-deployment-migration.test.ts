import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("preserves existing workflows, environment names and records while adding product ownership", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE tenants (id TEXT PRIMARY KEY);
      CREATE TABLE entities (id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL);
      CREATE TABLE products (id TEXT PRIMARY KEY);
      CREATE TABLE deployment_connections (id TEXT PRIMARY KEY, method TEXT);
      CREATE TABLE deployment_workflows (id TEXT PRIMARY KEY, "tenantId" TEXT, "entityId" TEXT NOT NULL, name TEXT, environment TEXT, format TEXT, "connectionId" TEXT);
      CREATE TABLE deployment_records (target TEXT, environment TEXT, version INT);
      INSERT INTO tenants VALUES ('tenant'); INSERT INTO entities VALUES ('entity', 'tenant'); INSERT INTO products VALUES ('product');
      INSERT INTO deployment_connections VALUES ('connection', 'http');
      INSERT INTO deployment_workflows VALUES ('legacy', 'tenant', 'entity', 'Legacy', 'custom-qa', 'avro', 'connection');
      INSERT INTO deployment_records VALUES ('entity:avro', 'canary', 3);`);
    await pg.exec(readFileSync(new URL("../../../prisma/migrations/20261110000000_shared_deployment_configuration/migration.sql", import.meta.url), "utf8"));
    expect((await pg.query<{ deploymentEnvironments: string[] }>('SELECT "deploymentEnvironments" FROM tenants')).rows[0].deploymentEnvironments).toEqual(["canary", "custom-qa", "development", "production", "staging"]);
    expect((await pg.query<{ deploymentTargetMethods: unknown }>('SELECT "deploymentTargetMethods" FROM tenants')).rows[0].deploymentTargetMethods).toEqual({ avro: ["git", "http", "registry"] });
    expect((await pg.query(`SELECT "entityId", "productId" FROM deployment_workflows WHERE id = 'legacy'`)).rows).toEqual([{ entityId: "entity", productId: null }]);
    expect((await pg.query('SELECT * FROM deployment_records')).rows).toEqual([{ target: "entity:avro", environment: "canary", version: 3 }]);
    await pg.exec(`INSERT INTO deployment_workflows (id, "tenantId", "productId", name, environment) VALUES ('shared', 'tenant', 'product', 'Shared', 'staging')`);
    await expect(pg.exec(`INSERT INTO deployment_workflows (id, "entityId", "productId") VALUES ('invalid', 'entity', 'product')`)).rejects.toThrow(/owner_check/);
  } finally { await pg.close(); }
});
