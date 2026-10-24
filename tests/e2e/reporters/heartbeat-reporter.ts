/**
 * A sign of life, for the stall watchdog of scripts/e2e-phases.mjs: rewrites one small file (`E2E_HEARTBEAT_FILE`) whenever the run
 * begins, a test starts or ends, and at the end, so the file's modification time is the time of the last thing that happened. The
 * script polls that time; a run whose heartbeat is older than `E2E_STALL_MS` is stuck (every worker idle, nothing finishing) and is ended.
 *
 * The file's text says what the last thing was ("begin", "test-begin", "test-end", "end ...", "error"): the script reads only whether it
 * starts with "end" (every test reported and the process still did not exit), to say so. The script does NOT stop watching at "end":
 * a run that hangs after its last test is the case it exists for.
 *
 * Added to the reporters by playwright.config.ts only when `E2E_HEARTBEAT_FILE` is set. It never throws: a heartbeat that cannot be
 * written must not fail a test run (the watchdog would then end a healthy one, which is the lesser evil of the two and is said).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";

export default class HeartbeatReporter implements Reporter {
  private readonly file: string | undefined;

  constructor() {
    this.file = process.env.E2E_HEARTBEAT_FILE || undefined;
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.beat(`begin ${suite.allTests().length} tests`);
  }

  onTestBegin(test: TestCase): void {
    this.beat(`test-begin ${test.title}`);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.beat(`test-end ${result.status} ${test.title}`);
  }

  onError(error: { message?: string }): void {
    this.beat(`error ${error.message ?? ""}`);
  }

  onEnd(result: FullResult): void {
    this.beat(`end ${result.status}`);
  }

  private beat(text: string): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${text.replace(/[\r\n]+/g, " ")}\n`);
    } catch {
      // a heartbeat that cannot be written is not a failed test
    }
  }
}
