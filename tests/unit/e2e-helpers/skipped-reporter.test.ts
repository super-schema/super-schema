/**
 * tests/e2e/reporters/skipped-reporter.ts: a skipped test is green in every report, so this writes every test that did not run, with why
 * (a static `test.skip(true, reason)`, a runtime `test.skip(condition, reason)`, `test.fixme`, or "did not run"), to the file the phases
 * script gates on. The list is written even when empty, and the reporter never throws.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FullConfig, Suite, TestCase } from "@playwright/test/reporter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SkippedReporter, { skipReasons, skippedRow } from "../../e2e/reporters/skipped-reporter";

type Annotation = { type: string; description?: string };

function fakeTest(
  over: { outcome?: "expected" | "unexpected" | "flaky" | "skipped"; annotations?: Annotation[]; resultAnnotations?: Annotation[]; statuses?: string[]; tags?: string[]; title?: string } = {},
): TestCase {
  const statuses = over.statuses ?? ["skipped"];
  return {
    outcome: () => over.outcome ?? "skipped",
    titlePath: () => ["", "chromium", "jsonschema-browser-verification.spec.ts", "A1 browser verification", over.title ?? "git mode any (second server)"],
    parent: { project: () => ({ name: "chromium" }) },
    location: { file: path.join(process.cwd(), "tests/e2e/jsonschema-browser-verification.spec.ts"), line: 96, column: 3 },
    tags: over.tags ?? ["@regression", "@external"],
    annotations: over.annotations ?? [],
    results: statuses.map((status) => ({ status, annotations: over.resultAnnotations ?? [] })),
  } as unknown as TestCase;
}

const suiteOf = (...tests: TestCase[]) => ({ allTests: () => tests }) as unknown as Suite;
const config = {} as FullConfig;

describe("skipReasons", () => {
  it("reads the reason of a static skip, a fixme, and a runtime test.skip(condition, reason), once each", () => {
    const test = fakeTest({
      annotations: [{ type: "fixme", description: "the crawl is flaky" }, { type: "tag", description: "@slow" }],
      resultAnnotations: [{ type: "skip", description: "https://x is not reachable" }, { type: "skip", description: "https://x is not reachable" }],
    });
    expect(skipReasons(test)).toEqual(["the crawl is flaky", "https://x is not reachable"]);
  });

  it("says so when a skip has no reason", () => {
    expect(skipReasons(fakeTest({ annotations: [{ type: "skip" }] }))).toEqual(["skip (no reason given)"]);
  });

  it("ignores annotations that are not skips (a tag, an issue, a test.fail)", () => {
    expect(skipReasons(fakeTest({ annotations: [{ type: "issue", description: "KD-024" }, { type: "fail", description: "known" }] }))).toEqual([]);
  });
});

describe("skippedRow", () => {
  it("is undefined for a test that ran (passed, failed, or was flaky)", () => {
    for (const outcome of ["expected", "unexpected", "flaky"] as const) expect(skippedRow(fakeTest({ outcome })), outcome).toBeUndefined();
  });

  it("describes a test that skipped itself at run time: project, title without the root, place, tags, the reason", () => {
    const row = skippedRow(fakeTest({ resultAnnotations: [{ type: "skip", description: "set E2E_GIT_ANY_BASE_URL" }] }));
    expect(row).toEqual({
      project: "chromium",
      title: "A1 browser verification › git mode any (second server)",
      file: "tests/e2e/jsonschema-browser-verification.spec.ts",
      line: 96,
      tags: ["@regression", "@external"],
      reasons: ["set E2E_GIT_ANY_BASE_URL"],
      startedThenSkipped: true,
    });
  });

  it("says 'did not run' for a selected test that never started (a failed dependency, --max-failures)", () => {
    const row = skippedRow(fakeTest({ statuses: [] }));
    expect(row?.startedThenSkipped).toBe(false);
    expect(row?.reasons[0]).toMatch(/^did not run/);
  });
});

describe("SkippedReporter", () => {
  let out: string;
  let written: string[];

  beforeEach(() => {
    out = path.join(mkdtempSync(path.join(os.tmpdir(), "skipped-reporter-")), "nested", "skipped-tests.json");
    written = [];
    vi.stubEnv("E2E_SKIPPED_FILE", out);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const read = () => JSON.parse(readFileSync(out, "utf8")) as unknown[];

  it("writes an EMPTY list, and prints nothing, when nothing was skipped (so 'nothing skipped' is not 'no list')", () => {
    const reporter = new SkippedReporter();
    reporter.onBegin(config, suiteOf(fakeTest({ outcome: "expected" }), fakeTest({ outcome: "unexpected" })));
    reporter.onEnd();
    expect(read()).toEqual([]);
    expect(written).toEqual([]);
  });

  it("writes every skipped test of the run (runtime skips included) and prints a SKIPPED block with the reasons", () => {
    const reporter = new SkippedReporter();
    reporter.onBegin(
      config,
      suiteOf(
        fakeTest({ outcome: "expected" }),
        fakeTest({ resultAnnotations: [{ type: "skip", description: "https://schemastore.org/ is not reachable from this machine" }] }),
        fakeTest({ title: "a fixme", tags: ["@regression"], annotations: [{ type: "fixme", description: "KD-1" }] }),
      ),
    );
    reporter.onEnd();
    const rows = read() as Array<{ title: string; reasons: string[]; tags: string[] }>;
    expect(rows.map((r) => r.title)).toEqual(["A1 browser verification › git mode any (second server)", "A1 browser verification › a fixme"]);
    expect(rows[0].reasons).toEqual(["https://schemastore.org/ is not reachable from this machine"]);
    const text = written.join("");
    expect(text).toContain("SKIPPED: 2 test(s) did not run");
    expect(text).toContain("[chromium] A1 browser verification › git mode any (second server) (tests/e2e/jsonschema-browser-verification.spec.ts:96, @regression @external): https://schemastore.org/ is not reachable from this machine");
    expect(text).toContain("a fixme");
  });

  it("writes nothing without E2E_SKIPPED_FILE (a bare run), and still prints the block", () => {
    vi.stubEnv("E2E_SKIPPED_FILE", "");
    const reporter = new SkippedReporter();
    reporter.onBegin(config, suiteOf(fakeTest()));
    reporter.onEnd();
    expect(existsSync(out)).toBe(false);
    expect(written.join("")).toContain("SKIPPED: 1 test(s)");
  });

  it("never throws when the file cannot be written", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "skipped-reporter-"));
    writeFileSync(path.join(dir, "blocker"), "a file where a directory is needed");
    vi.stubEnv("E2E_SKIPPED_FILE", path.join(dir, "blocker", "skipped-tests.json"));
    const reporter = new SkippedReporter();
    reporter.onBegin(config, suiteOf(fakeTest()));
    expect(() => reporter.onEnd()).not.toThrow();
  });

  it("is a reporter that prints to stdout, and tolerates onEnd without onBegin", () => {
    const reporter = new SkippedReporter();
    expect(reporter.printsToStdio()).toBe(true);
    expect(() => reporter.onEnd()).not.toThrow();
    expect(read()).toEqual([]);
  });
});
