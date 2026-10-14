// One-time batch migration (Story 12.7): give every entity its canonical
// typespecSource.   npm run db:migrate-typespec-source
//
// Not run with `tsx` like scripts/db.ts: this pulls in @typespec/compiler,
// which is ESM with top-level await, and tsx (CJS mode for this package)
// cannot require() it. The npm script bundles this file with esbuild (project
// code only; node_modules stay external and load natively) and runs the result
// with node. `server-only` is aliased to Next's empty stub in that step.

import "dotenv/config";
import { prisma } from "@/lib/db";
import { runTypeSpecSourceMigration } from "@/services/typespec-source-migration.service";

async function main() {
  const res = await runTypeSpecSourceMigration(prisma);
  if (!res.success) {
    console.error(res.error.message);
    await prisma.$disconnect();
    process.exit(1);
  }
  const { migrated, skipped, flagged, outcomes } = res.data;
  console.log(`TypeSpec source migration: ${migrated} migrated, ${skipped} skipped, ${flagged} flagged`);
  for (const o of outcomes.filter((x) => x.status === "FLAGGED")) {
    console.log(`  FLAGGED ${o.entityId}: ${o.diagnostics?.map((d) => `${d.code}: ${d.message}`).join("; ")}`);
  }
  await prisma.$disconnect();
}

void main();
