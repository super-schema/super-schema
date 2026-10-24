/**
 * Makes a flaky test (one that failed and then passed on a retry) impossible to miss: the run stays green, but every such test is
 * printed in a block of its own, written to `test-results/flaky-tests.json` and, on GitHub Actions, raised as a warning annotation.
 *
 * Why not rely on the built-in reporters alone: `list` prints "N flaky" and the html report has a Flaky filter, but the junit file
 * records a flaky test as a plain pass (checked with `retries: 1`: no flakyFailure element, only an attachment path in system-out), so
 * anything that reads the junit file, or the CI job summary, would not see it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestCase } from "@playwright/test/reporter";

interface Options {
  /** Where the JSON list goes; default `test-results/flaky-tests.json`. Nothing is written when no test was flaky. */
  outputFile?: string;
}

export default class FlakyReporter implements Reporter {
  private readonly flaky = new Map<string, TestCase>();
  private readonly outputFile: string;

  constructor(options: Options = {}) {
    this.outputFile = options.outputFile ?? "test-results/flaky-tests.json";
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
