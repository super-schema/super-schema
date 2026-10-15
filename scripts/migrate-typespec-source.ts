// One-time batch migration (Story 12.7): give every entity its canonical
// typespecSource.   npm run db:migrate-typespec-source
//
// Not run with `tsx` like scripts/db.ts: this pulls in @typespec/compiler,
// which is ESM with top-level await, and tsx (CJS mode for this package)
// cannot require() it. The npm script bundles this file with esbuild (project
// code only; node_modules stay external and load natively) and runs the result
// with node. `server-only` is aliased to scripts/stubs/server-only.cjs in that
// step.
//
// Exit code: 0 on success (flagged entities are reported but are not a
// failure); 1 if any entity errored or the run itself failed.

import "dotenv/config";
import { prisma } from "@/lib/db";
import { runTypeSpecSourceMigration } from "@/services/typespec-source-migration.service";

async function main(): Promise<number> {
  try {
    const res = await runTypeSpecSourceMigration(prisma);
    if (!res.success) {
      console.error(res.error.message);
      return 1;
    }
    const { migrated, skipped, flagged, errored, outcomes } = res.data;
    console.log(
      `TypeSpec source migration: ${migrated} migrated, ${skipped} skipped, ${flagged} flagged, ${errored} errored`
    );
    for (const o of outcomes.filter((x) => x.status === "FLAGGED")) {
      console.log(`  FLAGGED ${o.entityId}: ${o.diagnostics?.map((d) => `${d.code}: ${d.message}`).join("; ")}`);
    }
    for (const o of outcomes.filter((x) => x.status === "ERROR")) {
      console.log(`  ERROR ${o.entityId}: ${o.error}`);
    }
    return errored > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  });
