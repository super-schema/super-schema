// One-time backfill (controller ruling R42 follow-up): mark pre-R42 stored
// TypeSpec sources stale where they no longer match the entity's field rows.
//
//   npm run db:flag-stale-sources -- --dry-run   # report only
//   npm run db:flag-stale-sources                # write metadata.sourceStale
//
// Idempotent: entities already marked stale are skipped, and a source is only
// marked when its field projection (names + logical types) differs from the
// field rows, so publish regenerates exactly those sources. Runs under tsx:
// the comparison uses the regex TypeSpec parser and the generator, neither of
// which pulls in @typespec/compiler.
//
// Exit code: 0 on success; 1 if any entity errored or the run itself failed.

import "dotenv/config";
import { prisma } from "@/lib/db";
import { flagStaleTypeSpecSources } from "@/services/stale-source-flag.service";

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const res = await flagStaleTypeSpecSources(prisma, { dryRun });
    if (!res.success) {
      console.error(res.error.message);
      return 1;
    }
    const { checked, consistent, flagged, alreadyStale, changed, errored, outcomes } = res.data;
    console.log(
      `Stale TypeSpec source check${dryRun ? " (dry run)" : ""}: ${checked} checked, ${consistent} consistent, ` +
        `${flagged} ${dryRun ? "would be flagged" : "flagged"}, ${alreadyStale} already stale, ${changed} changed concurrently, ${errored} errored`
    );
    for (const o of outcomes) {
      if (o.status === "CONSISTENT" || o.status === "ALREADY_STALE") continue;
      const detail = o.error ?? o.reasons?.join("; ") ?? "";
      console.log(`  ${o.status} ${o.entityId} (${o.entityName}): ${detail}`);
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
