import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Which npm lifecycle steps may write to a database. A build is a function of the source; `dev` prepares the local database; production runs db:deploy.
const REPO = path.resolve(__dirname, "../../..");
const scripts = (JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

describe("npm scripts: which steps touch a database", () => {
  it("prebuild is exactly the generated client and the parser worker, so `npm run build` writes to no database (staging, production or a CI build)", () => {
    // Exact, not a pattern: any new step in prebuild (a db:* script, prisma, a migration) has to be a decision made here, on purpose.
    expect(scripts.prebuild).toBe("npm run db:generate && npm run build:parser-worker");
  });

  it("predev still prepares the local database for `npm run dev` (PGlite: pending migrations and the built-in traits)", () => {
    expect(scripts.predev).toContain("tsx scripts/db.ts ensure");
  });

  it("db:deploy is the production step: the migrations, then the built-in traits, for either provider", () => {
    expect(scripts["db:deploy"]).toBe("tsx scripts/db.ts deploy");
  });

  it("db:deploy fails when the built-in traits cannot be installed (strict), while ensure only reports it", () => {
    const dbScript = readFileSync(path.join(REPO, "scripts", "db.ts"), "utf8");
    expect(dbScript).toMatch(/installBuiltInTraits\(\{ strict: mode === "deploy" \}\)/);
  });
});

describe("prisma/seed.ts: the default tenant it creates has the built-in message properties", () => {
  it("installs them after the tenant upsert: the migrations create the tenant but install no traits, and `prisma migrate deploy` followed by the seed (the e2e release runner) must still get them", () => {
    const seed = readFileSync(path.join(REPO, "prisma", "seed.ts"), "utf8");
    const upsert = seed.indexOf("prisma.tenant.upsert(");
    expect(upsert).toBeGreaterThan(-1);
    expect(seed.indexOf("ensureBundledTraits(prisma, DEFAULT_TENANT_ID)")).toBeGreaterThan(upsert);
  });
});
