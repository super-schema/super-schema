/**
 * Makes a flaky test (one that failed and then passed on a retry) impossible to miss: the run stays green, but every such test is
 * printed in a block of its own, written to a JSON list (`E2E_FLAKY_FILE`, default `test-results/flaky-tests.json`) and, on GitHub
 * Actions, raised as a warning annotation.
 *
 * Why next to the built-in reporters: `list` prints "N flaky" and the html report has a Flaky filter, but they are for a person reading
 * the log or the report. Playwright's junit file records a flaky test as a plain pass unless `includeRetries` is on (the config turns
 * it on: a <flakyFailure> element, checked with `retries: 1`), and a CI job summary or a script wants a short machine-readable list of
 * exactly these tests, which is the JSON file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestCase } from "@playwright/test/reporter";

interface Options {
  /** Where the JSON list goes (`E2E_FLAKY_FILE` overrides it); default `test-results/flaky-tests.json`. Nothing is written when no test was flaky. */
  outputFile?: string;
}

export default class FlakyReporter implements Reporter {
  private readonly flaky = new Map<string, TestCase>();
  private readonly outputFile: string;

  constructor(options: Options = {}) {
    // Like Playwright's own reporters, the environment wins over the option: scripts/e2e-phases.mjs gives each phase a file of its own.
    this.outputFile = process.env.E2E_FLAKY_FILE || options.outputFile || "test-results/flaky-tests.json";
  }

  printsToStdio(): boolean {
    return true;
  }

  onTestEnd(test: TestCase): void {
    // `outcome()` is "flaky" only once an attempt failed and a later one passed.
    if (test.outcome() === "flaky") this.flaky.set(test.id, test);
  }

  onEnd(): void {
    if (this.flaky.size === 0) return;
    const rows = [...this.flaky.values()].map((test) => ({
      project: test.parent.project()?.name ?? "",
      title: test.titlePath().slice(3).join(" › "), // root, project and file are left out: the project and the location have fields of their own
      location: `${path.relative(process.cwd(), test.location.file)}:${test.location.line}`,
      attempts: test.results.length,
    }));
    const lines = rows.map((r) => `  [${r.project}] ${r.title} (${r.location}, passed on attempt ${r.attempts})`);
    process.stdout.write(`\nFLAKY: ${rows.length} test(s) failed and then passed on a retry. The run is green; fix or quarantine them:\n${lines.join("\n")}\n`);
    if (process.env.GITHUB_ACTIONS) {
      for (const r of rows) process.stdout.write(`::warning file=${r.location.split(":")[0]},title=Flaky test::${r.title.replace(/[\r\n]+/g, " ")}\n`);
    }
    mkdirSync(path.dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(rows, null, 2)}\n`);
  }
}
