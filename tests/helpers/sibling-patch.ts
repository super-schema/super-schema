/**
 * The Spanner, PostgreSQL and BigQuery emitters this repo uses come from the sibling repo (`node_modules/@typespec/*` link
 * into it) and need its `write.ts` patch (column comment after the comma; BigQuery escapes `\` and `'` itself). When a checkout
 * runs against an unpatched or unbuilt sibling, the assertions that depend on the patch must say so FIRST: use
 * {@link SIBLING_PATCH_HINT} as their message, and {@link execDdl} for DDL that goes to PGlite.
 */

export const SIBLING_PATCH_HINT =
  "the sibling emitter packages are not patched/rebuilt: see ~/super-schema-backups/parser-isolation-and-baseline-2026-10-19/WP-B-sibling-write.patch and docs/events/REVIEW.md gap 15";

/** `<hint>: <what failed>`, as an assertion message. */
export const withHint = (what: string): string => `${SIBLING_PATCH_HINT}: ${what}`;

/** Runs DDL on PGlite (or any `exec`); an error is rethrown with the pointer to the sibling patch put first. */
export async function execDdl(db: { exec(sql: string): Promise<unknown> }, ddl: string): Promise<void> {
  try {
    await db.exec(ddl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${SIBLING_PATCH_HINT}\n(PGlite said: ${reason})`, { cause: error });
  }
}
