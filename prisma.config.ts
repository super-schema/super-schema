import { loadEnvFile } from "./prisma/load-env-file";
import { resolve } from "node:path";
import { defineConfig } from "prisma/config";
import { initializeGitOpsEnvironment } from "./src/lib/gitops/config.mjs";

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile();
initializeGitOpsEnvironment();

// Note: `datasource.url` is consumed by Prisma CLI commands that connect over a
// wire protocol (migrate dev/deploy, studio, db pull) when DB_PROVIDER=postgresql.
// The embedded PGlite provider has no URL — its migrations are applied in-process
// via `npm run db:deploy` (scripts/db.ts), and new migrations are authored against
// PostgreSQL with `npm run db:migrate`.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
