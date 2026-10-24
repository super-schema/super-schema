/**
 * tests/e2e/reporters/heartbeat-reporter.ts: the sign of life the stall watchdog of scripts/e2e-phases.mjs reads. What is pinned: the file is
 * rewritten (so its modification time moves) at the begin, every test start and end and the end, its text says which, nothing is written
 * without E2E_HEARTBEAT_FILE, and a file that cannot be written never throws into the test run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import HeartbeatReporter from "../../e2e/reporters/heartbeat-reporter";

const test = (title: string) => ({ title }) as never;
const suite = (count: number) => ({ allTests: () => new Array(count).fill(null) }) as never;

describe("HeartbeatReporter", () => {
  let dir: string;
  let file: string;
  const before = process.env.E2E_HEARTBEAT_FILE;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ss-hb-"));
    file = path.join(dir, "nested", "heartbeat");
    process.env.E2E_HEARTBEAT_FILE = file;
  });

  afterEach(() => {
    if (before === undefined) delete process.env.E2E_HEARTBEAT_FILE;
    else process.env.E2E_HEARTBEAT_FILE = before;
    rmSync(dir, { recursive: true, force: true });
  });

  const text = () => readFileSync(file, "utf8");

  it("says what happened last, in a file it makes (the directory too) and rewrites", () => {
    const reporter = new HeartbeatReporter();
    reporter.onBegin({} as never, suite(3));
    expect(text()).toBe("begin 3 tests\n");
    reporter.onTestBegin(test("logs in"));
    expect(text()).toBe("test-begin logs in\n");
    reporter.onTestEnd(test("logs in"), { status: "passed" } as never);
    expect(text()).toBe("test-end passed logs in\n");
    reporter.onError({ message: "boom" });
    expect(text()).toBe("error boom\n");
    reporter.onEnd({ status: "passed" } as never);
    expect(text()).toBe("end passed\n");
  });

  it("keeps the file one line (a title with a newline cannot fake an 'end' line for the watchdog)", () => {
    const reporter = new HeartbeatReporter();
    reporter.onTestBegin(test("first\nend passed"));
    expect(text()).toBe("test-begin first end passed\n");
    expect(text().startsWith("end")).toBe(false);
  });

  it("writes nothing, and does not fail, without E2E_HEARTBEAT_FILE", () => {
    delete process.env.E2E_HEARTBEAT_FILE;
    const reporter = new HeartbeatReporter();
    expect(() => {
      reporter.onBegin({} as never, suite(1));
      reporter.onEnd({ status: "passed" } as never);
    }).not.toThrow();
  });

  it("does not throw into the run when the file cannot be written (its directory is a file)", () => {
    writeFileSync(path.join(dir, "blocker"), "x");
    process.env.E2E_HEARTBEAT_FILE = path.join(dir, "blocker", "heartbeat");
    const reporter = new HeartbeatReporter();
    expect(() => reporter.onTestBegin(test("x"))).not.toThrow();
  });

  it("prints nothing itself (the list reporter does)", () => {
    expect(new HeartbeatReporter().printsToStdio()).toBe(false);
  });
});
