import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  childNodeOptions,
  parserPoolStatus,
  runParserJob,
  setWorkerRebuildForTests,
  shutdownParserPool,
  type RunParserJobOptions,
} from "@/lib/event-specs/validation/parser-runner";
import { FAKE_WORKER, isAlive, sleep, waitUntil } from "./fixtures/fake-parser-worker";

/**
 * The runner against the fake worker (`fixtures/fake-parser-worker.ts`), the cases of the second round: workers that cannot start (no storm of
 * restarts, a breaker), a job handed to a worker that had just died, what a worker inherits from the server, limits from the environment, and a
 * worker that is stale (the bundle is older than its sources, outside production).
 */

let dir: string;
let fakeWorker: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "parser-resilience-"));
  fakeWorker = path.join(dir, "fake-worker.cjs");
  writeFileSync(fakeWorker, FAKE_WORKER);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  shutdownParserPool();
  setWorkerRebuildForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const useFakeWorker = (workers = 1) => {
  vi.stubEnv("ASYNCAPI_PARSER_WORKER", fakeWorker);
  vi.stubEnv("ASYNCAPI_PARSER_WORKERS", String(workers));
};

type Command = { do: string; ms?: number; tag?: number | string };
const run = (command: Command, options?: RunParserJobOptions) => runParserJob({ kind: "parseSource", text: JSON.stringify(command) }, options);
type Answer = { pid: number; tag: number | string | null };
/** What the fake worker answered; fails the test when the job did not run. */
async function answer(command: Command, options?: RunParserJobOptions): Promise<Answer> {
  const result = await run(command, options);
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return (result.data as unknown as { data: Answer }).data;
}
const failureOf = async (command: Command, options?: RunParserJobOptions) => {
  const result = await run(command, options);
  if (result.success) throw new Error("expected the job to fail");
  return result.error;
};
const codeOf = (result: { success: boolean; error?: { code: string } }): string => (result.success ? "ok" : (result.error as { code: string }).code);

/** Counts the starts of the fake worker (each start appends a line to a log this names). */
function trackStarts(): () => number {
  const log = path.join(dir, `starts-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, "");
  vi.stubEnv("FAKE_WORKER_LOG", log);
  return () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
}

describe("workers that cannot start (a failure of the pool, not of one worker)", () => {
  it.each([
    ["ends at start", { FAKE_WORKER_MODE: "crash-on-start" }],
    ["ends shortly after it starts, before it says ready", { FAKE_WORKER_MODE: "die-later", FAKE_WORKER_DIE_MS: "100" }],
  ])("a worker that %s: 2 workers and 3 waiting jobs make a handful of starts, not a stream, and every job is PARSER_CRASHED", async (_label, env) => {
    useFakeWorker(2);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const starts = trackStarts();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const results = await Promise.all([run({ do: "echo" }), run({ do: "echo" }), run({ do: "echo" })]);
    await sleep(1_200);

    expect(results.map(codeOf)).toEqual(["PARSER_CRASHED", "PARSER_CRASHED", "PARSER_CRASHED"]);
    expect(JSON.stringify(results)).not.toMatch(/code 3|code 4|signal|pid/); // a generic message: the cause is in the log
    expect(starts()).toBeLessThanOrEqual(5); // 2 in a pool of 2 (the storm made 16 a second)
    expect(parserPoolStatus()).toEqual({ workers: [], queued: 0 });
  });

  it("4 workers and 10 waiting jobs: the same", async () => {
    useFakeWorker(4);
    vi.stubEnv("FAKE_WORKER_MODE", "crash-on-start");
    const starts = trackStarts();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const results = await Promise.all(Array.from({ length: 10 }, () => run({ do: "echo" })));
    await sleep(1_200);
    expect(results.map(codeOf)).toEqual(Array(10).fill("PARSER_CRASHED"));
    expect(starts()).toBeLessThanOrEqual(7);
  });

  it("after 3 starts in a row that fail no worker is started for a while (jobs are PARSER_CRASHED at once, one line in the log), and the first ready closes the breaker", async () => {
    useFakeWorker(1);
    vi.stubEnv("ASYNCAPI_PARSER_BREAKER_MS", "600");
    vi.stubEnv("FAKE_WORKER_MODE", "crash-on-start");
    const starts = trackStarts();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const breakerLines = () => logged.mock.calls.filter((call) => String(call[0]).includes("in a row did not start")).length;

    for (let i = 0; i < 3; i += 1) expect((await failureOf({ do: "echo" })).code).toBe("PARSER_CRASHED");
    expect(starts()).toBe(3);
    expect(breakerLines()).toBe(1);

    // open: nothing is started, the answers are immediate and generic, and the log is not repeated per attempt
    const before = Date.now();
    for (let i = 0; i < 4; i += 1) expect((await failureOf({ do: "echo" })).code).toBe("PARSER_CRASHED");
    expect(Date.now() - before).toBeLessThan(300);
    await sleep(100);
    expect(starts()).toBe(3);
    expect(breakerLines()).toBe(1);

    // closed again after the delay: a healthy worker is started, and its ready clears the count
    await sleep(600);
    vi.stubEnv("FAKE_WORKER_MODE", "");
    const { pid } = await answer({ do: "echo" });
    expect(starts()).toBe(4);
    process.kill(pid, "SIGKILL");
    expect(await waitUntil(() => parserPoolStatus().workers.length === 0)).toBe(true);

    // two failures after that do not open it (the count started from 0 again): the third job still gets its attempt
    vi.stubEnv("FAKE_WORKER_MODE", "crash-on-start");
    for (let i = 0; i < 3; i += 1) expect((await failureOf({ do: "echo" })).code).toBe("PARSER_CRASHED");
    expect(starts()).toBe(7);
  });

  it("a worker file that is missing is still PARSER_UNAVAILABLE, not a start failure", async () => {
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", path.join(dir, "gone.cjs"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let i = 0; i < 4; i += 1) expect((await failureOf({ do: "echo" })).code).toBe("PARSER_UNAVAILABLE");
  });
});

describe("a job given to a worker that had just died", () => {
  it("is tried once more on a fresh worker: the dead one never had it", async () => {
    useFakeWorker();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pid } = await answer({ do: "echo" });

    process.kill(pid, "SIGKILL");
    const second = await answer({ do: "echo" }); // handed over in the same tick: the death is not noticed yet

    expect(second.pid).not.toBe(pid);
    expect(isAlive(second.pid)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("was lost before it took a parseSource job"));
  });

  it("only once: when the fresh worker dies before it takes the job as well, the job is PARSER_CRASHED and no third worker is started", async () => {
    useFakeWorker();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const starts = trackStarts();
    const { pid } = await answer({ do: "echo" }); // start 1
    process.kill(pid, "SIGKILL");
    vi.stubEnv("FAKE_WORKER_MODE", "die-before-ack"); // the fresh worker (start 2) is ready, then ends on the job without saying it has it
    expect(codeOf(await run({ do: "echo" }))).toBe("PARSER_CRASHED");
    await sleep(300);
    expect(starts()).toBe(2);
  });
});

describe("what a worker inherits from the server", () => {
  it.each([
    ["nothing", undefined, undefined],
    ["the debugger", "--inspect", ""],
    ["the debugger with a port and the heap limit", "--inspect=127.0.0.1:9229 --max-old-space-size=4096 --no-warnings", "--no-warnings"],
    ["a break at start, and a separate port", "--inspect-brk --inspect-port 9230 --require ./x.cjs", "--require ./x.cjs"],
    ["the other spellings", "--inspect-wait=0 --max_old_space_size=100 --debug-port=1 --trace-warnings", "--trace-warnings"],
    ["a heap limit with its value apart", "--max-old-space-size 4096 --enable-source-maps", "--enable-source-maps"],
    ["options that merely start like them", "--inspector-foo --max-old-space --stack-trace-limit=50", "--inspector-foo --max-old-space --stack-trace-limit=50"],
  ])("%s", (_label, raw, expected) => {
    expect(childNodeOptions(raw)).toBe(expected);
  });

  it("a worker gets NODE_OPTIONS without --inspect* and --max-old-space-size, and the heap limit once, on its command line", async () => {
    useFakeWorker();
    vi.stubEnv("NODE_OPTIONS", "--inspect=0 --no-warnings --inspect-port=0 --max-old-space-size=4096");
    const result = await run({ do: "env" });
    if (!result.success) throw new Error(result.error.code);
    const data = (result.data as unknown as { data: { nodeOptions: string | null; execArgv: string[] } }).data;
    expect(data.nodeOptions).toBe("--no-warnings");
    expect(data.execArgv).toEqual(["--max-old-space-size=768"]);
  });

  it("with only debugger options in NODE_OPTIONS the worker has none at all", async () => {
    useFakeWorker();
    vi.stubEnv("NODE_OPTIONS", "--inspect");
    const result = await run({ do: "env" });
    if (!result.success) throw new Error(result.error.code);
    expect((result.data as unknown as { data: { nodeOptions: string | null } }).data.nodeOptions).toBeNull();
  });

  it("with NODE_OPTIONS=--inspect on a fixed port the second worker starts as well", async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = server.address() as { port: number };
        server.close(() => resolve(free));
      });
    });
    useFakeWorker(2);
    vi.stubEnv("NODE_OPTIONS", `--inspect=127.0.0.1:${port}`);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const [a, b] = await Promise.all([answer({ do: "sleep", ms: 200 }), answer({ do: "sleep", ms: 200 })]);
    expect(a.pid).not.toBe(b.pid);
  });
});

describe("limits from the environment and the options", () => {
  it("a timeout over 2^31 - 1 ms is cut to it (a Node timer would fire after 1 ms), and one that is not positive or not a number is ignored", async () => {
    useFakeWorker();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const setting of ["99999999999", "1e300", "-5", "0", "soon", "", "Infinity"]) {
      vi.stubEnv("ASYNCAPI_PARSER_PARSE_TIMEOUT_MS", setting);
      expect((await answer({ do: "sleep", ms: 150 })).pid, setting).toBeGreaterThan(0);
    }
    vi.unstubAllEnvs();
    useFakeWorker();
    for (const timeoutMs of [1e12, Number.MAX_SAFE_INTEGER, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await answer({ do: "sleep", ms: 150 }, { timeoutMs })).pid, String(timeoutMs)).toBeGreaterThan(0);
    }
  });

  it("a waiting job's limit over 2^31 - 1 ms is cut to it as well (it does not fire at once)", async () => {
    useFakeWorker();
    await answer({ do: "echo" });
    const running = answer({ do: "sleep", ms: 300 });
    const waiting = answer({ do: "echo" }, { maxWaitMs: 1e12 });
    expect((await Promise.all([running, waiting])).length).toBe(2);
  });
});

describe("a worker that is stale (not in production)", () => {
  /**
   * A project directory in the shape of the real one: `worker-dist/asyncapi-parser-worker.cjs` with its `.meta.json` (one source), the source, and
   * a `scripts/build-parser-worker.mjs` that writes the worker again and notes it. The bundle is a minute old, the source two.
   */
  function project(options: { meta?: boolean } = {}) {
    const root = mkdtempSync(path.join(dir, "project-"));
    for (const sub of ["worker-dist", "src", "scripts"]) mkdirSync(path.join(root, sub));
    const worker = path.join(root, "worker-dist", "asyncapi-parser-worker.cjs");
    const input = path.join(root, "src", "a.txt");
    const buildsLog = path.join(root, "builds.log");
    writeFileSync(path.join(root, "fake-source.cjs"), FAKE_WORKER);
    writeFileSync(worker, FAKE_WORKER);
    writeFileSync(input, "a");
    if (options.meta !== false) writeFileSync(worker.replace(/\.cjs$/, ".meta.json"), JSON.stringify({ inputs: ["src/a.txt"] }));
    writeFileSync(
      path.join(root, "scripts", "build-parser-worker.mjs"),
      [
        'import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";',
        'const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
        'fs.appendFileSync(path.join(root, "builds.log"), "built\\n");',
        'fs.writeFileSync(path.join(root, "worker-dist", "asyncapi-parser-worker.cjs"), fs.readFileSync(path.join(root, "fake-source.cjs")));',
        "",
      ].join("\n"),
    );
    const age = (file: string, seconds: number) => {
      const when = new Date(Date.now() - seconds * 1000);
      utimesSync(file, when, when);
    };
    age(input, 120);
    age(worker, 60);
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", worker);
    vi.stubEnv("ASYNCAPI_PARSER_WORKERS", "1");
    return {
      /** The source is edited: newer than the bundle (60 s old), older than a bundle that is built now. */
      edit: () => age(input, 30),
      builds: () => (existsSync(buildsLog) ? readFileSync(buildsLog, "utf8").split("\n").filter(Boolean).length : 0),
    };
  }

  it("a source newer than the bundle: the build script runs once, the idle worker is replaced by one made from the new file, and the next jobs keep it", async () => {
    const p = project();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = await answer({ do: "echo" });
    expect(p.builds()).toBe(0); // nothing is built while the bundle is up to date

    p.edit();
    await sleep(1_100); // the disk is looked at once a second
    const second = await answer({ do: "echo" });

    expect(p.builds()).toBe(1);
    expect(second.pid).not.toBe(first.pid);
    expect(await waitUntil(() => !isAlive(first.pid))).toBe(true);
    const third = await answer({ do: "echo" });
    await sleep(1_100);
    const fourth = await answer({ do: "echo" });
    expect(p.builds()).toBe(1); // the new bundle is newer than the source: exactly one build
    expect([third.pid, fourth.pid]).toEqual([second.pid, second.pid]);
  });

  it("in production nothing is built at run time, however new a source is", async () => {
    const p = project();
    vi.stubEnv("NODE_ENV", "production");
    const first = await answer({ do: "echo" });
    p.edit();
    await sleep(1_100);
    const second = await answer({ do: "echo" });
    expect(p.builds()).toBe(0);
    expect(second.pid).toBe(first.pid);
  });

  it("without a .meta.json the check is skipped", async () => {
    const p = project({ meta: false });
    const first = await answer({ do: "echo" });
    p.edit();
    await sleep(1_100);
    expect((await answer({ do: "echo" })).pid).toBe(first.pid);
    expect(p.builds()).toBe(0);
  });

  it("a busy worker finishes its job first, and is replaced when it is idle", async () => {
    const p = project();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const running = answer({ do: "sleep", ms: 1_700, tag: "running" });
    await sleep(200);
    p.edit();
    await sleep(1_000);
    const waiting = answer({ do: "echo", tag: "waiting" }); // the pool has one worker and it is busy: this job is the one that sees the new source
    const [first, second] = await Promise.all([running, waiting]);
    expect(first.tag).toBe("running"); // not killed
    expect(p.builds()).toBe(1);
    expect(second.tag).toBe("waiting");
    expect(second.pid).not.toBe(first.pid);
  });

  it("a build that fails is logged, the old worker stays, and it is not tried again for a few seconds", async () => {
    const root = mkdtempSync(path.join(dir, "failing-"));
    const build = vi.fn(() => {
      throw new Error("esbuild said no");
    });
    setWorkerRebuildForTests({ inputs: () => ({ root, inputs: ["src/missing.ts"] }), build }); // a source that is gone counts as changed
    useFakeWorker();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = await answer({ do: "echo" });
    await sleep(1_100);
    const second = await answer({ do: "echo" });
    expect(second.pid).toBe(first.pid);
    expect(build).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("building it again failed"), expect.any(Error));
  });

  it("an injected list of sources and an injected build: one newer source, one build, one replacement", async () => {
    const root = mkdtempSync(path.join(dir, "injected-"));
    const source = path.join(root, "source.txt");
    writeFileSync(source, "s");
    const worker = path.join(root, "w.cjs");
    writeFileSync(worker, FAKE_WORKER);
    const at = (file: string, secondsFromNow: number) => utimesSync(file, new Date(Date.now() + secondsFromNow * 1000), new Date(Date.now() + secondsFromNow * 1000));
    at(worker, -60);
    at(source, -30); // newer than the bundle
    const build = vi.fn(() => at(worker, 0)); // "built again": newer than the source
    setWorkerRebuildForTests({ inputs: () => ({ root, inputs: ["source.txt"] }), build });
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", worker);
    vi.stubEnv("ASYNCAPI_PARSER_WORKERS", "1");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const first = await answer({ do: "echo" });
    expect(build).toHaveBeenCalledTimes(1);
    await sleep(1_100);
    const second = await answer({ do: "echo" });
    expect(build).toHaveBeenCalledTimes(1);
    expect(second.pid).toBe(first.pid);
  });
});
