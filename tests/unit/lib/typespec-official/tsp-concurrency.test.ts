/**
 * The `tsp` runs of this process share one limit (src/lib/typespec-official/emitter.service.ts): at most `TSP_MAX_CONCURRENT_RUNS` compiler
 * processes run at once, the rest queue, a refused run (a full line) never starts a process, and a run that fails gives its slot back. `tsp`
 * itself is faked (`execFile` is held open by the test), so the concurrency is what is measured.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => undefined, { [promisify.custom]: execFileMock });
  return { ...actual, execFile, default: { ...actual, execFile } };
});
vi.mock("@/lib/db", () => ({ prisma: {} }));

type Emitter = typeof import("@/lib/typespec-official/emitter.service");

/** Loads the emitter fresh, with the limit set in the environment, so its one process-wide limiter is built with that limit. */
async function loadEmitter(limit: string | undefined): Promise<Emitter> {
  vi.resetModules();
  if (limit === undefined) vi.stubEnv("TSP_MAX_CONCURRENT_RUNS", "");
  else vi.stubEnv("TSP_MAX_CONCURRENT_RUNS", limit);
  return import("@/lib/typespec-official/emitter.service");
}

/** Every `execFile` call of the fake `tsp` is held until the test ends it: `pending` lists them in the order they started. */
type Held = { resolve: () => void; reject: (error: unknown) => void; timeout: unknown };
let pending: Held[] = [];
let running = 0;
let peak = 0;
function holdEveryRun(): void {
  execFileMock.mockImplementation((_file: string, _args: string[], options: { timeout?: number }) => {
    running += 1;
    peak = Math.max(peak, running);
    return new Promise((resolve, reject) => {
      pending.push({
        timeout: options.timeout,
        resolve: () => {
          running -= 1;
          resolve({ stdout: "", stderr: "" });
        },
        reject: (error) => {
          running -= 1;
          reject(error);
        },
      });
    });
  });
}

/** Waits, on real timers, until the fake `tsp` has been started `count` times. */
async function untilCalled(count: number): Promise<void> {
  for (let i = 0; i < 2000 && execFileMock.mock.calls.length < count; i++) await new Promise((resolve) => setImmediate(resolve));
  expect(execFileMock).toHaveBeenCalledTimes(count);
}

const SOURCE = "model A {\n  id: string;\n}\n";

afterEach(() => {
  vi.unstubAllEnvs();
  execFileMock.mockReset();
  pending = [];
  running = 0;
  peak = 0;
});

describe("the limit of concurrent tsp runs", () => {
  it("never has more compiler processes running than the limit; the rest wait and start as slots free up", async () => {
    const { runTypeSpecEmitterWithWarnings } = await loadEmitter("2");
    holdEveryRun();

    const runs = Array.from({ length: 6 }, () => runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {}));
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(2));
    // Give the others every chance to start: none may, while two are running.
    await new Promise((resolve) => setImmediate(resolve));
    expect(execFileMock).toHaveBeenCalledTimes(2);

    for (let started = 2; started < 6; started++) {
      pending.shift()!.resolve();
      await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(started + 1));
    }
    while (pending.length > 0) pending.shift()!.resolve();
    await Promise.all(runs);

    expect(peak).toBe(2);
    expect(running).toBe(0);
  }, 60_000);

  it("a run that fails gives its slot back: the runs behind it still start", async () => {
    const { runTypeSpecEmitterWithWarnings } = await loadEmitter("1");
    holdEveryRun();

    const first = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {});
    const second = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {});
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    pending.shift()!.reject(Object.assign(new Error("Command failed: tsp compile"), { code: 1, stdout: "", stderr: "boom" }));

    const failed = await first;
    expect(failed.success).toBe(false);
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(2));
    pending.shift()!.resolve();
    await second;
    expect(peak).toBe(1);
  }, 60_000);

  it("the timeout of a run starts when its process starts: a queued run's clock does not run while it waits", async () => {
    const { runTypeSpecEmitterWithWarnings } = await loadEmitter("1");
    holdEveryRun();

    const first = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {}, { timeoutMs: 120_000 });
    const second = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {}, { timeoutMs: 5_000 });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(execFileMock).toHaveBeenCalledTimes(1);

    pending.shift()!.resolve();
    await first;
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(2));
    // The second run was spawned only now, and with its own timeout.
    expect(execFileMock.mock.calls[1][2]).toMatchObject({ timeout: 5_000, killSignal: "SIGKILL" });
    pending.shift()!.resolve();
    await second;
  }, 60_000);

  it("refuses a run at once, as EMITTER_BUSY, once the waiting line is full, and that run never starts a process", async () => {
    const { runTypeSpecEmitterWithWarnings, TSP_MAX_WAITING_RUNS } = await loadEmitter("1");
    holdEveryRun();

    const runs = Array.from({ length: TSP_MAX_WAITING_RUNS + 2 }, () => runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {}));
    const refused = await runs[TSP_MAX_WAITING_RUNS + 1];
    expect(refused.success).toBe(false);
    expect(!refused.success && refused.error.code).toBe("EMITTER_BUSY");
    expect(!refused.success && refused.error.message).toMatch(/busy/);
    // One run holds the slot and TSP_MAX_WAITING_RUNS wait; the refused one started nothing.
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Let every run finish, one after another: all but the refused one get their process and their answer.
    while (pending.length > 0 || execFileMock.mock.calls.length < TSP_MAX_WAITING_RUNS + 1) {
      if (pending.length === 0) await new Promise((resolve) => setImmediate(resolve));
      else pending.shift()!.resolve();
    }
    await Promise.all(runs);
    expect(execFileMock).toHaveBeenCalledTimes(TSP_MAX_WAITING_RUNS + 1);
  }, 120_000);

  it("reports the start of a run when it gets its slot, not while it waits: the caller's clock starts then", async () => {
    const { runTypeSpecEmitterWithWarnings } = await loadEmitter("1");
    holdEveryRun();
    const onStart = vi.fn();

    const first = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {});
    const second = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {}, { onStart });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onStart).not.toHaveBeenCalled();

    pending.shift()!.resolve();
    await first;
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(2));
    expect(onStart).toHaveBeenCalledTimes(1);
    pending.shift()!.resolve();
    await second;
  }, 60_000);

  it("a run cancelled while it waits starts no process, and answers EMITTER_CANCELLED", async () => {
    const { runTypeSpecEmitterWithWarnings } = await loadEmitter("1");
    holdEveryRun();
    const caller = new AbortController();

    const first = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {});
    const queued = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {}, { signal: caller.signal });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    caller.abort();
    pending.shift()!.resolve();
    await first;

    const cancelled = await queued;
    expect(!cancelled.success && cancelled.error.code).toBe("EMITTER_CANCELLED");
    await new Promise((resolve) => setImmediate(resolve));
    expect(execFileMock).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("a run that waits longer than the maximum wait is refused as EMITTER_BUSY, and starts no process; the run ahead of it is not affected", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { runTypeSpecEmitterWithWarnings, TSP_MAX_WAIT_MS } = await loadEmitter("1");
      holdEveryRun();

      const first = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {}, { timeoutMs: 120_000 });
      await untilCalled(1);
      const waiting = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {});
      await vi.advanceTimersByTimeAsync(TSP_MAX_WAIT_MS);

      const refused = await waiting;
      expect(!refused.success && refused.error.code).toBe("EMITTER_BUSY");
      expect(!refused.success && refused.error.message).toMatch(/busy/);
      await new Promise((resolve) => setImmediate(resolve));
      expect(execFileMock).toHaveBeenCalledTimes(1);

      pending.shift()!.resolve();
      await first;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a run whose caller is already gone starts nothing, and never queues", async () => {
    const { runTypeSpecEmitterWithWarnings } = await loadEmitter("1");
    holdEveryRun();
    const caller = new AbortController();
    caller.abort();
    const run = await runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {}, { signal: caller.signal });
    expect(!run.success && run.error.code).toBe("EMITTER_CANCELLED");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("hands the signal to the compiler process; a process killed because its caller went away is EMITTER_CANCELLED, not a timeout", async () => {
    const { runTypeSpecEmitterWithWarnings } = await loadEmitter("1");
    holdEveryRun();
    const caller = new AbortController();

    const run = runTypeSpecEmitterWithWarnings("@typespec/json-schema", SOURCE, {}, { signal: caller.signal, timeoutMs: 120_000 });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ signal: caller.signal, killSignal: "SIGKILL" });
    caller.abort();
    pending.shift()!.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", killed: true }));

    const result = await run;
    expect(!result.success && result.error.code).toBe("EMITTER_CANCELLED");
  }, 60_000);
});

describe("the busy flag of a target result", () => {
  it("is set only for a run refused because the compiler is busy", async () => {
    vi.resetModules();
    const { resultFromEmissionError } = await import("@/lib/typespec-official/emitter.service");
    const busy = resultFromEmissionError({ code: "EMITTER_BUSY", message: "The TypeSpec compiler is busy." });
    expect(busy).toMatchObject({ validationStatus: "INVALID", busy: true });
    const failed = resultFromEmissionError({ code: "EMITTER_TIMEOUT", message: "did not finish" });
    expect(failed.validationStatus).toBe("INVALID");
    expect("busy" in failed).toBe(false);
  });
});

describe("how the limit is chosen (tspMaxConcurrentRuns)", () => {
  it("uses TSP_MAX_CONCURRENT_RUNS when it is a whole number of at least 1", async () => {
    const { tspMaxConcurrentRuns } = await loadEmitter(undefined);
    expect(tspMaxConcurrentRuns({ TSP_MAX_CONCURRENT_RUNS: "3" }, 16)).toBe(3);
    expect(tspMaxConcurrentRuns({ TSP_MAX_CONCURRENT_RUNS: " 12 " }, 2)).toBe(12);
    expect(tspMaxConcurrentRuns({ TSP_MAX_CONCURRENT_RUNS: "1" }, 64)).toBe(1);
  });

  it("is half the cores, and at least one, when the variable is unset or not a positive whole number", async () => {
    const { tspMaxConcurrentRuns } = await loadEmitter(undefined);
    expect(tspMaxConcurrentRuns({}, 16)).toBe(8);
    expect(tspMaxConcurrentRuns({}, 9)).toBe(4);
    expect(tspMaxConcurrentRuns({}, 2)).toBe(1);
    expect(tspMaxConcurrentRuns({}, 1)).toBe(1);
    for (const value of ["", "   ", "0", "-2", "2.5", "1e3", "abc", "07", "4 cores"]) {
      expect(tspMaxConcurrentRuns({ TSP_MAX_CONCURRENT_RUNS: value }, 16), JSON.stringify(value)).toBe(8);
    }
  });
});
