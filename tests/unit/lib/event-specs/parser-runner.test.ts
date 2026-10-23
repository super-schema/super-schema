import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  parserPoolStatus,
  runParserJob,
  shutdownParserPool,
  type RunParserJobOptions,
} from "@/lib/event-specs/validation/parser-runner";
import { FAKE_WORKER } from "./fixtures/fake-parser-worker";

/**
 * The runner (`parser-runner.ts`) against a tiny FAKE worker (no parser in it): what a job costs, what a timeout does to the child, what a
 * crash, a bad message or a missing worker file do, the queue, the pool size. The real worker is exercised in `parser-isolation.test.ts`.
 */

let dir: string;
let fakeWorker: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "parser-runner-"));
  fakeWorker = path.join(dir, "fake-worker.cjs");
  writeFileSync(fakeWorker, FAKE_WORKER);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  shutdownParserPool();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const useFakeWorker = (workers = 1) => {
  vi.stubEnv("ASYNCAPI_PARSER_WORKER", fakeWorker);
  vi.stubEnv("ASYNCAPI_PARSER_WORKERS", String(workers));
};

type Command = { do: string; ms?: number; tag?: number | string };
const run = (command: Command, options?: RunParserJobOptions) => runParserJob({ kind: "parseSource", text: JSON.stringify(command) }, options);
/** What the fake worker answered (`{ pid, tag }`); fails the test when the job did not run. */
async function answer(command: Command, options?: RunParserJobOptions): Promise<{ pid: number; tag: number | string | null }> {
  const result = await run(command, options);
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return (result.data as unknown as { data: { pid: number; tag: number | string | null } }).data;
}
const failureOf = async (command: Command, options?: RunParserJobOptions) => {
  const result = await run(command, options);
  if (result.success) throw new Error("expected the job to fail");
  return result.error;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(condition: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}

describe("a job in a child process", () => {
  it("is answered by a process that is not this one, and the worker stays warm for the next job", async () => {
    useFakeWorker();
    const first = await answer({ do: "echo" });
    const second = await answer({ do: "echo" });
    expect(first.pid).not.toBe(process.pid);
    expect(second.pid).toBe(first.pid);
    expect(parserPoolStatus().workers).toEqual([{ pid: first.pid, state: "idle" }]);
  });

  it("a worker is started only when a job needs it", async () => {
    useFakeWorker();
    expect(parserPoolStatus().workers).toEqual([]);
    await answer({ do: "echo" });
    expect(parserPoolStatus().workers).toHaveLength(1);
  });
});

describe("the time limit", () => {
  it("kills the child (the process is gone), answers PARSER_TIMEOUT with the limit used, and the next job runs on a fresh child", async () => {
    useFakeWorker();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pid } = await answer({ do: "echo" });

    const started = Date.now();
    const error = await failureOf({ do: "hang" }, { timeoutMs: 300 });
    const took = Date.now() - started;

    expect(error.code).toBe("PARSER_TIMEOUT");
    expect(error.details).toEqual({ timeoutMs: 300 });
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(1_500);
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("was killed"));

    const next = await answer({ do: "echo" });
    expect(next.pid).not.toBe(pid);
    expect(isAlive(next.pid)).toBe(true);
  });

  it("the default limits are 15 s (validate) and 4 s (parseSource), and the environment overrides them", async () => {
    useFakeWorker();
    vi.stubEnv("ASYNCAPI_PARSER_PARSE_TIMEOUT_MS", "250");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = await failureOf({ do: "hang" });
    expect(error).toMatchObject({ code: "PARSER_TIMEOUT", details: { timeoutMs: 250 } });
    const { DEFAULT_TIMEOUT_MS } = await import("@/lib/event-specs/validation/parser-runner");
    expect(DEFAULT_TIMEOUT_MS).toEqual({ validate: 15_000, importValidate: 15_000, parseSource: 4_000 });
  });

  it("starts counting when the job is SENT: a slow start of the worker is not part of the limit", async () => {
    useFakeWorker();
    vi.stubEnv("FAKE_WORKER_READY_MS", "600");
    const result = await answer({ do: "echo" }, { timeoutMs: 300 });
    expect(result.pid).toBeGreaterThan(0);
  });
});

describe("a worker that is lost", () => {
  it("crashing in the middle of a job is PARSER_CRASHED (a generic message, the cause in the log) and the worker is replaced; a job the worker had taken is not tried again", async () => {
    useFakeWorker();
    const startsLog = path.join(dir, "starts-crash.log");
    writeFileSync(startsLog, "");
    vi.stubEnv("FAKE_WORKER_LOG", startsLog);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { pid } = await answer({ do: "echo" });

    const error = await failureOf({ do: "crash" });
    await sleep(300);

    expect(readFileSync(startsLog, "utf8").split("\n").filter(Boolean)).toHaveLength(1); // no replacement was started for a retry: the worker had the job
    expect(error.code).toBe("PARSER_CRASHED");
    expect(JSON.stringify(error)).not.toMatch(/code 1|signal|\/srv|pid/);
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/was lost while it ran a parseSource job: it ended \(code 1/));
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
    expect((await answer({ do: "echo" })).pid).not.toBe(pid);
  });

  it.each([
    ["a message of an unknown type", { do: "garbage" }],
    ["an answer to a job it was not given", { do: "wrong-id" }],
    ["an answer that is not JSON", { do: "bad-body" }],
  ])("%s is PARSER_CRASHED: the worker is killed and replaced", async (_label, command) => {
    useFakeWorker();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { pid } = await answer({ do: "echo" });
    expect((await failureOf(command)).code).toBe("PARSER_CRASHED");
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
    expect((await answer({ do: "echo" })).pid).not.toBe(pid);
  });

  it("an exception inside the job is PARSER_JOB_FAILED, its text only in the log, and the worker is kept", async () => {
    useFakeWorker();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { pid } = await answer({ do: "echo" });
    const error = await failureOf({ do: "throw" });
    expect(error.code).toBe("PARSER_JOB_FAILED");
    expect(JSON.stringify(error)).not.toContain("/srv/secret");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("the parser failed on a parseSource job"), "boom at /srv/secret/path.js:1:1");
    expect((await answer({ do: "echo" })).pid).toBe(pid);
  });

  it("a worker that ends at start, or never says ready, answers PARSER_CRASHED once and is not started again and again", async () => {
    useFakeWorker();
    const log = path.join(dir, "starts.log");
    writeFileSync(log, "");
    vi.stubEnv("FAKE_WORKER_LOG", log);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const starts = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;

    vi.stubEnv("FAKE_WORKER_MODE", "crash-on-start");
    expect((await failureOf({ do: "echo" })).code).toBe("PARSER_CRASHED");
    await sleep(300);
    expect(starts()).toBe(1);
    expect(parserPoolStatus()).toEqual({ workers: [], queued: 0 });

    vi.stubEnv("FAKE_WORKER_MODE", "never-ready");
    vi.stubEnv("ASYNCAPI_PARSER_START_TIMEOUT_MS", "300");
    expect((await failureOf({ do: "echo" })).code).toBe("PARSER_CRASHED");
    await sleep(300);
    expect(starts()).toBe(2);
    expect(parserPoolStatus()).toEqual({ workers: [], queued: 0 });
  });
});

describe("messages", () => {
  it("a job over the message limit is refused before anything is started", async () => {
    useFakeWorker();
    vi.stubEnv("ASYNCAPI_PARSER_MAX_MESSAGE_BYTES", "1000");
    const error = await failureOf({ do: "echo", tag: "x".repeat(2_000) });
    expect(error).toMatchObject({ code: "PARSER_MESSAGE_TOO_LARGE", details: { direction: "to-worker", limitBytes: 1000 } });
    expect(parserPoolStatus().workers).toEqual([]);
  });

  it("an answer the worker found over the limit is PARSER_MESSAGE_TOO_LARGE, and the worker is kept", async () => {
    useFakeWorker();
    const { pid } = await answer({ do: "echo" });
    const error = await failureOf({ do: "too-large" });
    expect(error).toMatchObject({ code: "PARSER_MESSAGE_TOO_LARGE", details: { direction: "from-worker" } });
    expect((await answer({ do: "echo" })).pid).toBe(pid);
  });

  it("a document that cannot be written as JSON is PARSER_BAD_JOB, without a worker", async () => {
    useFakeWorker();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const result = await runParserJob({ kind: "validate", document: cycle });
    expect(result.success ? null : result.error.code).toBe("PARSER_BAD_JOB");
    expect(parserPoolStatus().workers).toEqual([]);
  });
});

describe("the pool", () => {
  it("answers waiting jobs in the order they came", async () => {
    useFakeWorker(1);
    await answer({ do: "echo" }); // warm
    const order: Array<number | string | null> = [];
    const jobs = [0, 1, 2, 3, 4].map((tag) => answer({ do: "sleep", ms: 30, tag }).then((a) => order.push(a.tag)));
    await Promise.all(jobs);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("answers PARSER_BUSY beyond the queue limit, at once, and still serves the jobs that are queued", async () => {
    useFakeWorker(1);
    await answer({ do: "echo" }); // warm: the first job below goes straight to the worker
    const running = answer({ do: "sleep", ms: 500, tag: "running" }, { maxQueued: 2 });
    const queued1 = answer({ do: "echo", tag: "q1" }, { maxQueued: 2 });
    const queued2 = answer({ do: "echo", tag: "q2" }, { maxQueued: 2 });
    const started = Date.now();
    const refused = await failureOf({ do: "echo", tag: "q3" }, { maxQueued: 2 });
    expect(Date.now() - started).toBeLessThan(200);
    expect(refused).toMatchObject({ code: "PARSER_BUSY", details: { reason: "queue-full", maxQueued: 2 } });
    expect(parserPoolStatus().queued).toBe(2);
    expect((await Promise.all([running, queued1, queued2])).map((a) => a.tag)).toEqual(["running", "q1", "q2"]);
  });

  it("answers PARSER_BUSY to a job that waited too long for a worker, and the one that held the worker is not harmed", async () => {
    useFakeWorker(1);
    await answer({ do: "echo" });
    const running = answer({ do: "sleep", ms: 600, tag: "running" });
    const started = Date.now();
    const refused = await failureOf({ do: "echo" }, { maxWaitMs: 150 });
    const took = Date.now() - started;
    expect(refused).toMatchObject({ code: "PARSER_BUSY", details: { reason: "wait-timeout", maxWaitMs: 150 } });
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(500);
    expect((await running).tag).toBe("running");
    expect(parserPoolStatus().queued).toBe(0);
  });

  it("runs two jobs at once on two workers", async () => {
    useFakeWorker(2);
    // each job holds its worker for a while, so the second one cannot be served by the first worker once that one is ready
    const [a, b] = await Promise.all([answer({ do: "sleep", ms: 100 }), answer({ do: "sleep", ms: 100 })]);
    expect(a.pid).not.toBe(b.pid);
    const started = Date.now();
    const [x, y] = await Promise.all([answer({ do: "sleep", ms: 400 }), answer({ do: "sleep", ms: 400 })]);
    const took = Date.now() - started;
    expect(new Set([x.pid, y.pid])).toEqual(new Set([a.pid, b.pid])); // both workers were kept warm
    expect(took).toBeLessThan(700); // one worker would need 800
  });

  it("never starts more workers than ASYNCAPI_PARSER_WORKERS, clamped to 1 - 4 (default 2, also for anything that is not a number)", async () => {
    const peak = async (setting: string | undefined) => {
      vi.stubEnv("ASYNCAPI_PARSER_WORKER", fakeWorker);
      vi.stubEnv("ASYNCAPI_PARSER_WORKERS", setting as string);
      const jobs = Array.from({ length: 8 }, () => answer({ do: "sleep", ms: 150 }));
      await sleep(60);
      const workers = parserPoolStatus().workers.length;
      await Promise.all(jobs);
      shutdownParserPool();
      return workers;
    };
    expect(await peak("9")).toBe(4);
    expect(await peak("0")).toBe(1); // a number is clamped to 1 - 4
    expect(await peak("-3")).toBe(1);
    expect(await peak("1")).toBe(1);
    expect(await peak("2.9")).toBe(2);
    expect(await peak("not a number")).toBe(2); // anything else is the default
    expect(await peak("")).toBe(2);
  }, 30_000);

  it("shutdownParserPool kills every worker and answers what is waiting", async () => {
    useFakeWorker(1);
    const { pid } = await answer({ do: "echo" });
    const running = run({ do: "sleep", ms: 5_000 });
    const waiting = run({ do: "echo" });
    await sleep(50);
    shutdownParserPool();
    expect((await running).success).toBe(false);
    expect((await waiting).success).toBe(false);
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
    expect(parserPoolStatus()).toEqual({ workers: [], queued: 0 });
  });
});

describe("where the worker comes from", () => {
  it("a missing worker file FAILS CLOSED (PARSER_UNAVAILABLE), names the fix in the log, and runs nothing in this process", async () => {
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", path.join(dir, "no-such-worker.cjs"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runParserJob({ kind: "parseSource", text: "asyncapi: 3.0.0\ninfo:\n  title: t\n  version: '1'\n" });
    expect(result.success ? null : result.error.code).toBe("PARSER_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain(dir);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("npm run build:parser-worker"));
    expect(parserPoolStatus().workers).toEqual([]);
  });

  it("ASYNCAPI_PARSER_IN_PROCESS=1 runs the job in this process, with no worker", async () => {
    vi.stubEnv("ASYNCAPI_PARSER_IN_PROCESS", "1");
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", path.join(dir, "no-such-worker.cjs")); // not looked at
    const result = await runParserJob({ kind: "parseSource", text: "asyncapi: 3.0.0\ninfo:\n  title: t\n  version: '1'\n" });
    expect(result).toMatchObject({ success: true, data: { success: true, data: { asyncapi: "3.0.0" } } });
    expect(parserPoolStatus().workers).toEqual([]);
    // the first in-process parse loads the AsyncAPI parser in this process: slow under load, 5 s is too tight
  }, 30_000);

  it("the default place is worker-dist/ in the working directory, where the build script puts it", async () => {
    // no ASYNCAPI_PARSER_WORKER: the file that globalSetup built
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", "");
    const result = await runParserJob({ kind: "parseSource", text: "asyncapi: 3.0.0\ninfo:\n  title: t\n  version: '1'\n" });
    expect(result).toMatchObject({ success: true, data: { success: true, data: { asyncapi: "3.0.0" } } });
    expect(parserPoolStatus().workers).toHaveLength(1);
  });
});
