/**
 * The CI reporter that keeps a flaky test (failed, then passed on a retry) visible: Playwright's junit file records it as a plain pass,
 * so this prints a FLAKY block, writes a JSON list and, on GitHub Actions, raises a warning annotation. The run itself stays green.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestCase } from "@playwright/test/reporter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FlakyReporter from "../../e2e/reporters/flaky-reporter";

function fakeTest(outcome: "expected" | "unexpected" | "flaky" | "skipped", id = "t1"): TestCase {
  return {
    id,
    outcome: () => outcome,
    titlePath: () => ["", "chromium", "events-builder.spec.ts", "event builder end to end", "the draft survives a reload"],
    parent: { project: () => ({ name: "chromium" }) },
    location: { file: path.join(process.cwd(), "tests/e2e/events-builder.spec.ts"), line: 214, column: 7 },
    results: [{}, {}],
  } as unknown as TestCase;
}

describe("FlakyReporter", () => {
  let out: string;
  let written: string[];

  beforeEach(() => {
    out = path.join(mkdtempSync(path.join(os.tmpdir(), "flaky-reporter-")), "nested", "flaky-tests.json");
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prints nothing and writes nothing when no test was flaky", () => {
    const reporter = new FlakyReporter({ outputFile: out });
    reporter.onTestEnd(fakeTest("expected"));
    reporter.onTestEnd(fakeTest("unexpected", "t2"));
    reporter.onTestEnd(fakeTest("skipped", "t3"));
    reporter.onEnd();
    expect(written).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it("lists a flaky test once, with its project, title, place and attempts, and writes the JSON", () => {
    const reporter = new FlakyReporter({ outputFile: out });
    reporter.onTestEnd(fakeTest("flaky"));
    reporter.onTestEnd(fakeTest("flaky")); // the same test reported twice (another attempt): still one row
    reporter.onEnd();

    const text = written.join("");
    expect(text).toContain("FLAKY: 1 test(s)");
    expect(text).toContain("[chromium] event builder end to end › the draft survives a reload");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
      {
        project: "chromium",
        title: "event builder end to end › the draft survives a reload",
        location: "tests/e2e/events-builder.spec.ts:214",
        attempts: 2,
      },
    ]);
  });

  it("raises a GitHub warning annotation only on GitHub Actions", () => {
    const quiet = new FlakyReporter({ outputFile: out });
    quiet.onTestEnd(fakeTest("flaky"));
    quiet.onEnd();
    expect(written.join("")).not.toContain("::warning");

    written.length = 0;
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const annotated = new FlakyReporter({ outputFile: out });
    annotated.onTestEnd(fakeTest("flaky"));
    annotated.onEnd();
    expect(written.join("")).toContain("::warning file=tests/e2e/events-builder.spec.ts,title=Flaky test::event builder end to end › the draft survives a reload");
  });
});
