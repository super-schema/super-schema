/**
 * Makes a skipped test impossible to miss. A skipped test is green in every report ("1 skipped"), so a precondition that is never met
 * (an environment variable nobody sets, a server nobody starts) makes a test pass forever without running: that was the state of the
 * `git mode any (second server)` test. This reporter writes every test that did not run to a JSON list (`E2E_SKIPPED_FILE`, which
 * scripts/e2e-phases.mjs gives each phase), with WHY: the reason of a static `test.skip(true, "...")` / `test.fixme`, and of a runtime
 * `test.skip(condition, "reason")` (an annotation of the test after the run), or "did not run" for a selected test that never started
 * (a failed dependency project, `--max-failures`, an interrupted run). It also prints a SKIPPED block.
 *
 * The phases script reads the file and decides: a skip is allowed only for a test tagged `@external` (a network or second-server
 * precondition; allowed to skip, with the reason listed loudly) or when the shell says `E2E_ALLOW_SKIPS=1`; any other skip makes the phase fail
 * (exit 1). The file is written even when nothing was skipped (an empty list), so "nothing skipped" is told apart from "the reporter did not run".
 *
 * Added to the reporters by playwright.config.ts only when `E2E_SKIPPED_FILE` is set. It never throws.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FullConfig, Reporter, Suite, TestCase } from "@playwright/test/reporter";

/** One test that did not run. The shape of `skipped-tests.json` (read by scripts/e2e-phases.mjs and scripts/ci-flaky-summary.mjs). */
export interface SkippedRow {
  project: string;
  /** The title without the root, project and file: `describe › test`. */
  title: string;
  /** Relative to the working directory. */
  file: string;
  line: number;
  tags: string[];
  /** Why, in the words of the test; "did not run" when it never started. */
  reasons: string[];
  /** Whether the test started and then skipped itself (a runtime `test.skip(...)`), as opposed to never starting. */
  startedThenSkipped: boolean;
}

/** What a test says about its own skip: every `skip` / `fixme` annotation (static, and added at run time), once each. */
export function skipReasons(test: Pick<TestCase, "annotations" | "results">): string[] {
  const annotations = [...test.annotations, ...test.results.flatMap((result) => result.annotations ?? [])];
  const reasons: string[] = [];
  for (const annotation of annotations) {
    if (annotation.type !== "skip" && annotation.type !== "fixme") continue;
    const text = annotation.description?.trim() ? annotation.description.trim() : `${annotation.type} (no reason given)`;
    if (!reasons.includes(text)) reasons.push(text);
  }
  return reasons;
}

/** The row of a test that did not run, or undefined for one that did. */
export function skippedRow(test: TestCase): SkippedRow | undefined {
  if (test.outcome() !== "skipped") return undefined;
  const reasons = skipReasons(test);
  return {
    project: test.parent.project()?.name ?? "",
    title: test.titlePath().slice(3).join(" › "),
    file: path.relative(process.cwd(), test.location.file),
    line: test.location.line,
    tags: [...test.tags],
    reasons: reasons.length > 0 ? reasons : ["did not run (a failed dependency, --max-failures, or an interrupted run)"],
    startedThenSkipped: test.results.length > 0 && test.results.every((result) => result.status === "skipped"),
  };
}

export default class SkippedReporter implements Reporter {
  private suite: Suite | undefined;
  private readonly outputFile: string | undefined;

  constructor() {
    this.outputFile = process.env.E2E_SKIPPED_FILE || undefined;
  }

  printsToStdio(): boolean {
    return true;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.suite = suite;
  }

  onEnd(): void {
    const rows = (this.suite?.allTests() ?? []).flatMap((test) => skippedRow(test) ?? []);
    if (rows.length > 0) {
      const lines = rows.map((row) => `  [${row.project}] ${row.title} (${row.file}:${row.line}${row.tags.length ? `, ${row.tags.join(" ")}` : ""}): ${row.reasons.join("; ")}`);
      process.stdout.write(`\nSKIPPED: ${rows.length} test(s) did not run. A skip is green in every report: the phases script fails the run for any that is not @external.\n${lines.join("\n")}\n`);
    }
    if (!this.outputFile) return;
    try {
      mkdirSync(path.dirname(this.outputFile), { recursive: true });
      writeFileSync(this.outputFile, `${JSON.stringify(rows, null, 2)}\n`);
    } catch {
      // the phases script then reports the missing list: the gate cannot be checked, which it says
    }
  }
}
