import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadEnvFile } from "../../prisma/load-env-file";

const envKeys = ["DATABASE_URL", "NEXTAUTH_SECRET", "NEXTAUTH_URL", "EXISTING_ENV"];

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of envKeys) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("Prisma config environment loading", () => {
  const snapshot = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const tempDirs: string[] = [];

  afterEach(() => {
    restoreEnv(snapshot);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads .env values without depending on dotenv/config", () => {
    for (const key of envKeys) {
      delete process.env[key];
    }

    const dir = mkdtempSync(join(tmpdir(), "super-schema-env-"));
    tempDirs.push(dir);
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      [
        "# local development values",
        "DATABASE_URL=postgresql://superschema:password@localhost:5432/superschema",
        "NEXTAUTH_SECRET=dev secret",
        "NEXTAUTH_URL=\"http://localhost:3000\"",
      ].join("\n")
    );

    loadEnvFile(envPath);

    expect(process.env.DATABASE_URL).toBe(
      "postgresql://superschema:password@localhost:5432/superschema"
    );
    expect(process.env.NEXTAUTH_SECRET).toBe("dev secret");
    expect(process.env.NEXTAUTH_URL).toBe("http://localhost:3000");
  });

  it("preserves environment variables already set by the shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "super-schema-env-"));
    tempDirs.push(dir);
    const envPath = join(dir, ".env");
    process.env.EXISTING_ENV = "from-shell";
    writeFileSync(envPath, "EXISTING_ENV=from-file\n");

    loadEnvFile(envPath);

    expect(process.env.EXISTING_ENV).toBe("from-shell");
  });

  it("keeps Prisma config free of dotenv runtime imports", () => {
    const configSource = readFileSync("prisma.config.ts", "utf8");

    expect(configSource).not.toContain("dotenv/config");
  });
});

describe("Prisma migration history", () => {
  it("creates registry tables and columns required by the current schema", () => {
    const latestMigration = readFileSync(
      "prisma/migrations/20260407121000_add_domain_asset_registry/migration.sql",
      "utf8"
    );

    expect(latestMigration).toContain('CREATE TABLE "business_concepts"');
    expect(latestMigration).toContain('CREATE TABLE "field_concept_links"');
    expect(latestMigration).toContain('ADD COLUMN "parentEntityId" TEXT');
    expect(latestMigration).toContain('business_concepts_name_key');
    expect(latestMigration).toContain('field_concept_links_fieldId_conceptId_key');
    expect(latestMigration).toContain('entities_parentEntityId_fkey');
  });

  it("keeps domain and entity slug defaults aligned with schema", () => {
    const slugMigration = readFileSync(
      "prisma/migrations/20260405_add_slug_columns/migration.sql",
      "utf8"
    );

    expect(slugMigration).toContain('ALTER TABLE "domains" ALTER COLUMN "slug" DROP DEFAULT');
    expect(slugMigration).toContain('ALTER TABLE "entities" ALTER COLUMN "slug" DROP DEFAULT');
  });
});
