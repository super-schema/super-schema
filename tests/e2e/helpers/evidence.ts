/**
 * Where a spec writes what it leaves behind to be looked at (screenshots, the generated text of every target, a step table): ONE directory per run.
 *
 * Three specs wrote to fixed paths under /tmp/e2e-evidence, so two runs at the same time (two worktrees, a nightly and a local run) wrote the same
 * files and read each other's. scripts/e2e-phases.mjs gives every phase `E2E_EVIDENCE_DIR=<output root>/test-results/evidence` (the output root is the run's
 * own: scripts/e2e-release.mjs), so the evidence of a run sits next to its reports and server.log, is uploaded with them, and is removed with them.
 * A bare `playwright test` has no such variable: its evidence goes to `test-results/e2e-evidence` of the working directory (Playwright empties
 * `test-results` at the start of a run, so it is never an earlier run's).
 *
 * Free of Playwright on purpose: it is plain path arithmetic, unit tested in tests/unit/e2e-helpers/evidence.test.ts.
 */
import path from "node:path";

/** The directory for `segments` (a spec's name, a test's id) under the run's evidence directory. Not created: the writer makes it. */
export function evidenceDir(...segments: string[]): string {
  const base = process.env.E2E_EVIDENCE_DIR || path.join(process.cwd(), "test-results", "e2e-evidence");
  return path.join(base, ...segments);
}
