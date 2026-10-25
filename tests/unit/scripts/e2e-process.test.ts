/**
 * scripts/e2e-process.mjs: how the suite's scripts start, signal and end a child. What is pinned is what went wrong without it: a signal
 * forwarded twice (the terminal had already sent it to the whole group), a signal to a child that has workers (only the leader got
 * it), and a child that ignores SIGTERM and is never ended.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_STALL_MS,
  STALL_EXIT_CODE,
  createInterrupt,
  descendantsOf,
  exitCodeForSignal,
  formatDuration,
  killTree,
  parseMillis,
  pollMsFor,
  readHeartbeat,
  signalGroup,
  spawnGroup,
  stopStalledChild,
  terminateGroup,
  treeBelow,
  watchForStall,
} from "../../../scripts/e2e-process.mjs";

describe("signalGroup", () => {
  it("signals the whole group (the negative pid) on POSIX", () => {
    const kill = vi.fn();
    expect(signalGroup({ pid: 4242 }, "SIGINT", { kill, platform: "darwin" })).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGINT");
  });

  it("signals the child alone where there are no groups", () => {
    const kill = vi.fn();
    signalGroup({ pid: 4242 }, "SIGTERM", { kill, platform: "win32" });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("says false for a child that never started or is gone (ESRCH), or whose group only waits to be reaped (EPERM on macOS: it crashed the phases script's forced kill in the real SIGINT run)", () => {
    const kill = vi.fn();
    expect(signalGroup({}, "SIGINT", { kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    for (const code of ["ESRCH", "EPERM"]) {
      const gone = vi.fn(() => {
        throw Object.assign(new Error(code), { code });
      });
      expect(signalGroup({ pid: 1 }, "SIGINT", { kill: gone, platform: "linux" })).toBe(false);
    }
  });

  it("rethrows any other error", () => {
    const broken = vi.fn(() => {
      throw Object.assign(new Error("invalid signal"), { code: "EINVAL" });
    });
    expect(() => signalGroup({ pid: 1 }, "SIGNOPE", { kill: broken, platform: "linux" })).toThrow("invalid signal");
  });
});

describe("createInterrupt", () => {
  function fakeTimers() {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    return {
      timers,
      setTimer: (fn: () => void, ms: number) => {
        const timer = { fn, ms, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer: { cleared: boolean }) => {
        if (timer) timer.cleared = true;
      },
    };
  }

  it("forwards the first signal once, and starts the grace period", () => {
    const forward = vi.fn();
    const force = vi.fn();
    const t = fakeTimers();
    const interrupt = createInterrupt({ forward, force, graceMs: 5000, ...t });
    expect(interrupt.interrupted).toBe(false);
    interrupt.handle("SIGINT");
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith("SIGINT");
    expect(interrupt.interrupted).toBe(true);
    expect(interrupt.signal).toBe("SIGINT");
    expect(t.timers.map((x) => x.ms)).toEqual([5000]);
    expect(force).not.toHaveBeenCalled();
  });

  it("forces the child when the grace period ends", () => {
    const force = vi.fn();
    const t = fakeTimers();
    const interrupt = createInterrupt({ forward: vi.fn(), force, ...t });
    interrupt.handle("SIGTERM");
    t.timers[0].fn();
    expect(force).toHaveBeenCalledTimes(1);
  });

  it("forces it at once on a second signal, and ignores every later one: never a second forward", () => {
    const forward = vi.fn();
    const force = vi.fn();
    const t = fakeTimers();
    let clock = 0;
    const interrupt = createInterrupt({ forward, force, now: () => clock, ...t });
    for (const signal of ["SIGINT", "SIGINT", "SIGHUP", "SIGTERM"]) {
      interrupt.handle(signal);
      clock += 5000; // each one well after the debounce window of the one before
    }
    expect(forward).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledTimes(1);
    expect(t.timers[0].cleared).toBe(true);
    expect(interrupt.signal).toBe("SIGINT"); // the first one is what the run reports
  });

  it("counts a signal that follows the first within the debounce window as the same one (npm forwards the signal it got, the terminal had already sent it)", () => {
    const forward = vi.fn();
    const force = vi.fn();
    let clock = 10_000;
    const t = fakeTimers();
    const interrupt = createInterrupt({ forward, force, debounceMs: 1000, now: () => clock, ...t });
    interrupt.handle("SIGINT");
    clock += 40; // npm's forward of the same Ctrl-C
    interrupt.handle("SIGINT");
    expect(force).not.toHaveBeenCalled();
    expect(t.timers[0].cleared).toBe(false);
    clock += 3000; // the user presses it again: that one means it
    interrupt.handle("SIGINT");
    expect(forward).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledTimes(1);
  });

  it("done() cancels the forced kill of a run that ended by itself", () => {
    const t = fakeTimers();
    const interrupt = createInterrupt({ forward: vi.fn(), force: vi.fn(), ...t });
    interrupt.handle("SIGINT");
    interrupt.done();
    expect(t.timers[0].cleared).toBe(true);
  });
});

describe("terminateGroup", () => {
  /** A child that is a leader of group 777; `exit()` ends it. */
  function fakeChild() {
    const child = Object.assign(new EventEmitter(), { pid: 777, exitCode: null as number | null, signalCode: null as string | null });
    return { child, exit: () => { child.exitCode = 0; child.emit("exit", 0, null); } };
  }
  function fakeTimers() {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    return {
      timers,
      setTimer: (fn: () => void, ms: number) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer: { cleared: boolean }) => {
        if (timer) timer.cleared = true;
      },
    };
  }

  it("sends SIGTERM to the group, then a last SIGKILL to what the leader left behind, when the leader exits in time", async () => {
    const { child, exit } = fakeChild();
    const kill = vi.fn();
    const t = fakeTimers();
    const done = terminateGroup(child, { kill, platform: "linux", ...t });
    expect(kill.mock.calls).toEqual([[-777, "SIGTERM"]]);
    exit();
    await done;
    expect(kill.mock.calls).toEqual([[-777, "SIGTERM"], [-777, "SIGKILL"]]);
    expect(t.timers[0].cleared).toBe(true);
  });

  it("sends SIGKILL after the grace period to a leader that ignores SIGTERM, and resolves when it exits", async () => {
    const { child, exit } = fakeChild();
    const kill = vi.fn();
    const t = fakeTimers();
    const done = terminateGroup(child, { kill, platform: "linux", graceMs: 3000, ...t });
    expect(t.timers[0].ms).toBe(3000);
    t.timers[0].fn(); // the grace period is over, the leader is still there
    expect(kill.mock.calls).toEqual([[-777, "SIGTERM"], [-777, "SIGKILL"]]);
    exit();
    await done;
  });

  it("resolves by itself shortly after a SIGKILL that the leader never answers", async () => {
    const { child } = fakeChild();
    const t = fakeTimers();
    const done = terminateGroup(child, { kill: vi.fn(), platform: "linux", ...t });
    t.timers[0].fn();
    expect(t.timers[1].ms).toBe(2000);
    t.timers[1].fn();
    await done;
  });

  it("only sweeps the group when the leader has already exited", async () => {
    const { child, exit } = fakeChild();
    exit();
    const kill = vi.fn();
    await terminateGroup(child, { kill, platform: "linux", ...fakeTimers() });
    expect(kill.mock.calls).toEqual([[-777, "SIGKILL"]]);
  });

  it("does nothing for a child that never started", async () => {
    const kill = vi.fn();
    await terminateGroup(Object.assign(new EventEmitter(), { pid: undefined }), { kill, ...fakeTimers() });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("descendantsOf / killTree", () => {
  // pid ppid, as `ps -A -o pid=,ppid=` prints them: 10 -> 11 -> 13, 10 -> 12, and an unrelated 20 -> 21
  const ps = "   10     1\n   11    10\n   12    10\n   13    11\n   20     1\n   21    20\n";

  it("lists the children, grandchildren ... of a process, whatever process group they are in", () => {
    expect(descendantsOf(ps, 10).sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(descendantsOf(ps, 11)).toEqual([13]);
    expect(descendantsOf(ps, 13)).toEqual([]);
    expect(descendantsOf(ps, 99)).toEqual([]);
  });

  it("ignores a line that is not two numbers", () => {
    expect(descendantsOf("PID PPID\n 10 1\n 11 10\n\n", 10)).toEqual([11]);
  });

  it("kills the deepest first and the process itself last, and never fails on one that is already gone", () => {
    const killed: Array<[number, string]> = [];
    const kill = (pid: number, signal: string) => {
      killed.push([pid, signal]);
      if (pid === 12) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    };
    killTree(10, { listProcesses: () => ps, kill, platform: "linux" });
    expect(killed).toEqual([[13, "SIGKILL"], [12, "SIGKILL"], [11, "SIGKILL"], [10, "SIGKILL"]]);
  });

  it("falls back to the process alone when the process list cannot be read", () => {
    const kill = vi.fn();
    killTree(10, { listProcesses: () => { throw new Error("no ps"); }, kill, platform: "linux" });
    expect(kill.mock.calls).toEqual([[10, "SIGKILL"]]);
  });
});

describe("exitCodeForSignal", () => {
  it("is 128 + the signal number", () => {
    expect([exitCodeForSignal("SIGHUP"), exitCodeForSignal("SIGINT"), exitCodeForSignal("SIGTERM")]).toEqual([129, 130, 143]);
    expect(exitCodeForSignal("SIGUSR1")).toBe(1);
  });
});

describe("spawnGroup (real process)", () => {
  it.skipIf(process.platform === "win32")("leads a group of its own: signalling the group ends the child and what it started", async () => {
    // The child starts a sleeping grandchild of its own, then waits: only a group signal ends both.
    const child = spawnGroup(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {stdio:'inherit'}); setTimeout(()=>{},60000)"], { stdio: "ignore" });
    const exited = new Promise<string | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    await vi.waitFor(() => expect(child.pid).toBeGreaterThan(0));
    expect(signalGroup(child, "SIGTERM")).toBe(true);
    expect(await exited).toBe("SIGTERM");
    await terminateGroup(child, { graceMs: 1000 });
    // The group is gone: signal 0 to it finds nobody.
    expect(() => process.kill(-(child.pid as number), 0)).toThrow(/ESRCH/);
  });
});

describe("treeBelow", () => {
  const ps = "   10     1\n   11    10\n   13    11\n   20     1\n";

  it("reads the processes below a pid, and nothing where ps is not there (or on Windows)", () => {
    expect(treeBelow(10, { listProcesses: () => ps, platform: "linux" }).sort()).toEqual([11, 13]);
    expect(treeBelow(10, { listProcesses: () => { throw new Error("no ps"); }, platform: "linux" })).toEqual([]);
    expect(treeBelow(10, { listProcesses: () => ps, platform: "win32" })).toEqual([]);
  });
});

describe("the stall watchdog's small pieces", () => {
  it("parseMillis: unset or empty is no value, a positive whole number is itself, anything else names the variable", () => {
    expect(parseMillis("E2E_STALL_MS", undefined)).toBeUndefined();
    expect(parseMillis("E2E_STALL_MS", "")).toBeUndefined();
    expect(parseMillis("E2E_STALL_MS", "20000")).toBe(20000);
    for (const bad of ["0", "-5", "1.5", "5min", "abc", " 5"]) {
      expect(() => parseMillis("E2E_STALL_MS", bad), bad).toThrow(`E2E_STALL_MS must be a positive whole number of milliseconds (got "${bad}")`);
    }
  });

  it("the default is twenty minutes (above the longest test timeout of the suite: the guard below keeps it so)", () => {
    expect(DEFAULT_STALL_MS).toBe(1_200_000);
    expect(STALL_EXIT_CODE).toBe(124);
  });

  it("polls every 15 s, and more often when the limit is short (so a limit of 2 s is not overshot by 15)", () => {
    expect(pollMsFor(DEFAULT_STALL_MS)).toBe(15_000);
    expect(pollMsFor(20_000)).toBe(5000);
    expect(pollMsFor(2000)).toBe(500);
    expect(pollMsFor(100)).toBe(250);
  });

  it("formats the idle time as seconds under a minute, else minutes", () => {
    expect(formatDuration(20_000)).toBe("20 s");
    expect(formatDuration(300_000)).toBe("5 min");
    expect(formatDuration(330_000)).toBe("5.5 min");
  });

  it("readHeartbeat reads the mtime and the text of a file, and is undefined where there is none", () => {
    expect(readHeartbeat("/nope", { stat: () => ({ mtimeMs: 5 }), read: () => "test-end passed x\n" })).toEqual({ mtimeMs: 5, text: "test-end passed x\n" });
    expect(
      readHeartbeat("/nope", {
        stat: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    ).toBeUndefined();
  });
});

describe("watchForStall", () => {
  /**
   * A monotonic clock, a wall clock and an interval that the test drives. `tick(ms)` moves BOTH clocks on and runs the poll once (a single
   * jump larger than the poll period is what a sleeping machine looks like); `run(ms)` moves them on in poll-sized steps (time passing normally);
   * `sleep(ms)` moves only the wall clock (a platform whose monotonic clock does not count a suspended machine) and runs one poll.
   */
  function harness(beat: { mtimeMs: number; text: string } | undefined, options: { stallMs?: number; pollMs?: number } = {}) {
    let clock = 5_000; // the monotonic clock: unrelated to the wall clock on purpose
    let wall = 1_000_000;
    let poll: (() => void) | undefined;
    const cleared: unknown[] = [];
    const stalls: Array<{ idleMs: number; ended: boolean }> = [];
    const sleeps: number[] = [];
    const pollMs = options.pollMs ?? 15_000;
    const state = { beat };
    const watcher = watchForStall({
      stallMs: options.stallMs ?? 300_000,
      pollMs,
      readHeartbeat: () => state.beat,
      onStall: (info) => stalls.push(info),
      onSleep: (gapMs) => sleeps.push(gapMs),
      now: () => clock,
      wallNow: () => wall,
      setTimer: (fn: () => void) => {
        poll = fn;
        return { unref() {} };
      },
      clearTimer: (timer: unknown) => cleared.push(timer),
    });
    return {
      watcher,
      stalls,
      sleeps,
      cleared,
      state,
      /** The wall clock: where a heartbeat's modification time comes from. */
      wall: () => wall,
      tick(ms: number) {
        clock += ms;
        wall += ms;
        poll?.();
      },
      run(ms: number) {
        for (let left = ms; left > 0; left -= pollMs) {
          const step = Math.min(pollMs, left);
          clock += step;
          wall += step;
          poll?.();
        }
      },
      sleep(ms: number) {
        wall += ms;
        poll?.();
      },
    };
  }

  it("does not fire while the heartbeat is fresh, and fires once it is stallMs old", () => {
    const h = harness({ mtimeMs: 1_000_000, text: "begin 3 tests" });
    h.run(60_000);
    h.state.beat = { mtimeMs: h.wall(), text: "test-end passed a" }; // a test ended: a sign of life
    h.run(285_000);
    expect(h.stalls).toEqual([]);
    h.run(30_000); // the beat was seen at the poll after it was written; 300 s after that poll the run is stalled
    expect(h.stalls).toHaveLength(1);
    expect(h.stalls[0]).toMatchObject({ ended: false });
    expect(h.stalls[0].idleMs).toBeGreaterThanOrEqual(300_000);
    expect(h.watcher.stalled).toBe(true);
  });

  it("every new heartbeat (a different modification time) resets the idle time, however long the run is", () => {
    const h = harness({ mtimeMs: 1_000_000, text: "begin" }, { stallMs: 60_000 });
    for (let i = 0; i < 40; i += 1) {
      h.run(45_000); // three quarters of the limit, then a beat: the run is alive for 30 minutes
      h.state.beat = { mtimeMs: h.wall(), text: `test-end ${i}` };
    }
    expect(h.stalls).toEqual([]);
    h.run(75_000);
    expect(h.stalls).toHaveLength(1);
  });

  it("the same modification time is not a beat (a heartbeat that is read again and again)", () => {
    const h = harness({ mtimeMs: 1_000_100, text: "test-begin x" }, { stallMs: 60_000 });
    h.run(45_000);
    expect(h.stalls).toEqual([]);
    h.run(30_000);
    expect(h.stalls).toHaveLength(1);
  });

  it("fires only once, and stops polling when it has fired", () => {
    const h = harness({ mtimeMs: 1_000_000, text: "test-begin x" }, { stallMs: 30_000 });
    h.run(60_000);
    h.run(30_000);
    expect(h.stalls).toHaveLength(1);
    expect(h.cleared).toHaveLength(1);
  });

  it("counts from the start of the watch while there is no heartbeat file yet (Playwright that never began)", () => {
    const h = harness(undefined, { stallMs: 120_000 });
    h.run(105_000);
    expect(h.stalls).toEqual([]);
    h.run(15_000);
    expect(h.stalls).toEqual([{ idleMs: 120_000, ended: false }]);
  });

  it("ignores a heartbeat older than the watch (a file of an earlier run)", () => {
    const h = harness({ mtimeMs: 10, text: "end passed" }, { stallMs: 60_000 });
    h.run(45_000);
    expect(h.stalls).toEqual([]);
    h.run(15_000);
    expect(h.stalls).toHaveLength(1);
  });

  it("does NOT stop at an 'end' heartbeat: a run that hangs after its last test is stalled, and says every test had finished", () => {
    const h = harness({ mtimeMs: 1_000_000, text: "end passed\n" }, { stallMs: 60_000 });
    h.run(45_000);
    expect(h.stalls).toEqual([]);
    h.run(30_000);
    expect(h.stalls).toHaveLength(1);
    expect(h.stalls[0].ended).toBe(true);
  });

  it("a machine that slept does not end a healthy run: the clock jumped by far more than a poll period, so the idle time starts again", () => {
    const h = harness({ mtimeMs: 1_000_000, text: "begin" }, { stallMs: 300_000, pollMs: 15_000 });
    h.run(30_000);
    h.tick(8 * 3_600_000); // the laptop slept for eight hours: the heartbeat is eight hours old by the wall clock
    expect(h.stalls).toEqual([]);
    expect(h.sleeps).toEqual([8 * 3_600_000]);
    h.run(285_000); // and the run then has its whole limit again
    expect(h.stalls).toEqual([]);
    h.run(15_000);
    expect(h.stalls).toHaveLength(1);
  });

  it("a run that is beating after the machine woke is never ended", () => {
    const h = harness({ mtimeMs: 1_000_000, text: "begin" }, { stallMs: 60_000 });
    h.tick(2 * 3_600_000);
    for (let i = 0; i < 20; i += 1) {
      h.run(30_000);
      h.state.beat = { mtimeMs: h.wall(), text: `test-end ${i}` };
    }
    expect(h.stalls).toEqual([]);
  });

  it("a wall clock that jumped alone (a monotonic clock that does not count sleep) is no stall either: idle time is read from the monotonic clock", () => {
    const h = harness({ mtimeMs: 1_000_000, text: "begin" }, { stallMs: 60_000 });
    h.run(30_000);
    h.sleep(10 * 3_600_000);
    h.run(15_000);
    expect(h.stalls).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });

  it("a real stall still fires after a sleep: the limit counts again from the wake-up, with no beat", () => {
    const h = harness({ mtimeMs: 1_000_000, text: "begin" }, { stallMs: 60_000 });
    h.run(15_000); // the one heartbeat there will ever be is seen
    h.tick(3_600_000);
    h.run(45_000);
    expect(h.stalls).toEqual([]);
    h.run(15_000);
    expect(h.stalls).toEqual([{ idleMs: 60_000, ended: false }]);
  });

  it("a gap of up to four poll periods (a busy machine) is not a sleep, and a stall in it still fires", () => {
    const h = harness(undefined, { stallMs: 30_000, pollMs: 15_000 });
    h.tick(60_000); // exactly four periods: a late timer, not a sleep
    expect(h.sleeps).toEqual([]);
    expect(h.stalls).toHaveLength(1);
  });

  it("stop() ends the watch (the child exited): no stall afterwards", () => {
    const h = harness({ mtimeMs: 1_000_000, text: "x" }, { stallMs: 10_000 });
    h.watcher.stop();
    expect(h.cleared).toHaveLength(1);
    expect(h.watcher.stalled).toBe(false);
  });
});

describe("stopStalledChild", () => {
  const ps = "   777     1\n   801   777\n   802   801\n   900     1\n"; // 777 is the leader; 801 a worker with a browser 802; 900 unrelated

  function fakeChild() {
    const child = Object.assign(new EventEmitter(), { pid: 777, exitCode: null as number | null, signalCode: null as string | null });
    return { child, exit: () => { child.exitCode = 0; child.emit("exit", 0, null); } };
  }

  it("asks the group to end, and kills what was below the leader (the browser first) once it has gone, leaving the unrelated alone", async () => {
    const { child, exit } = fakeChild();
    const killed: Array<[number, string]> = [];
    const kill = (pid: number, signal: string) => {
      killed.push([pid, signal]);
    };
    const done = stopStalledChild(child, { graceMs: 5000, listProcesses: () => ps, kill, platform: "linux", setTimer: () => ({}), clearTimer: () => {} });
    expect(killed).toEqual([[-777, "SIGTERM"]]);
    exit();
    await done;
    expect(killed).toEqual([[-777, "SIGTERM"], [-777, "SIGKILL"], [802, "SIGKILL"], [801, "SIGKILL"]]);
  });

  it("gives the leader the grace period and then SIGKILLs the group", async () => {
    const { child, exit } = fakeChild();
    const kill = vi.fn();
    const timers: Array<() => void> = [];
    const done = stopStalledChild(child, { graceMs: 5000, listProcesses: () => ps, kill, platform: "linux", setTimer: (fn: () => void) => { timers.push(fn); return {}; }, clearTimer: () => {} });
    timers[0](); // the grace period ends with the leader still there
    expect(kill.mock.calls).toContainEqual([-777, "SIGKILL"]);
    exit();
    await done;
  });

  it("never rejects when a process below is already gone or ps is missing", async () => {
    const { child, exit } = fakeChild();
    const kill = vi.fn((pid: number) => {
      if (pid === 802) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const done = stopStalledChild(child, { listProcesses: () => { throw new Error("no ps"); }, kill, platform: "linux", setTimer: () => ({}), clearTimer: () => {} });
    exit();
    await expect(done).resolves.toBeUndefined();
  });
});

describe("the watchdog, with a real process and a real heartbeat file", () => {
  /** A "Playwright": it starts a worker in a process group of its own (as a browser is), writes the worker's pid to `pidFile`, and waits a minute. */
  const childSource = (pidFile: string) =>
    `const g = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' }); ` +
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setTimeout(()=>{},60000)`;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** A started child and its worker, a heartbeat file, and the clean-up of all of it. */
  async function start() {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-heartbeat-"));
    const file = path.join(dir, "heartbeat");
    const pidFile = path.join(dir, "worker.pid");
    writeFileSync(file, "begin 1 tests\n");
    const child = spawnGroup(process.execPath, ["-e", childSource(pidFile)], { stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    await vi.waitFor(() => expect(() => readFileSync(pidFile, "utf8")).not.toThrow(), { timeout: 5000 });
    const workerPid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(workerPid)).toBe(true);
    const cleanUp = () => {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {
        // already gone
      }
      void terminateGroup(child, { graceMs: 200 });
      rmSync(dir, { recursive: true, force: true });
    };
    return { file, child, exited, workerPid, cleanUp };
  }

  it.skipIf(process.platform === "win32")("ends a child that never beats, and the worker it started in a group of its own", async () => {
    const run = await start();
    try {
      let stopped: Promise<void> | undefined;
      const info = await new Promise<{ idleMs: number; ended: boolean }>((resolve) => {
        watchForStall({
          stallMs: 1000,
          pollMs: 100,
          readHeartbeat: () => readHeartbeat(run.file),
          onStall: (stall) => {
            stopped = stopStalledChild(run.child, { graceMs: 1000 });
            resolve(stall);
          },
        });
      });
      expect(info.ended).toBe(false); // the last word was "begin", not "end"
      await stopped;
      expect((await run.exited).signal).toBe("SIGTERM");
      // The worker is in a group of its own: the group signal did not reach it, the tree that was read before the leader went did.
      await vi.waitFor(() => expect(alive(run.workerPid)).toBe(false), { timeout: 5000 });
    } finally {
      run.cleanUp();
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")("leaves a child that keeps beating alone for four times the limit, and ends it once it stops", async () => {
    const run = await start();
    try {
      let stalls = 0;
      let stopped: Promise<void> | undefined;
      const watcher = watchForStall({
        stallMs: 1000,
        pollMs: 100,
        readHeartbeat: () => readHeartbeat(run.file),
        onStall: () => {
          stalls += 1;
          stopped = stopStalledChild(run.child, { graceMs: 1000 });
        },
      });
      const beats = setInterval(() => utimesSync(run.file, new Date(), new Date()), 100);
      await new Promise((resolve) => setTimeout(resolve, 4000)); // four times the limit, beating all the while
      expect(stalls).toBe(0);
      expect(watcher.stalled).toBe(false);
      expect(run.child.exitCode).toBeNull();
      expect(run.child.signalCode).toBeNull();
      expect(alive(run.workerPid)).toBe(true);

      clearInterval(beats); // the run stops making progress
      await vi.waitFor(() => expect(stalls).toBe(1), { timeout: 5000 });
      await stopped;
      expect((await run.exited).signal).toBe("SIGTERM");
      await vi.waitFor(() => expect(alive(run.workerPid)).toBe(false), { timeout: 5000 });
    } finally {
      run.cleanUp();
    }
  }, 30_000);
});

describe("the stall limit stays above the longest test the suite declares", () => {
  const REPO = path.resolve(__dirname, "../../..");
  const E2E_DIR = path.join(REPO, "tests", "e2e");

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) return files(file);
      return /\.ts$/.test(name) ? [file] : [];
    });
  }

  /** `420_000`, `300000`, `5 * 60_000`: a duration written as numbers (and products of them) only. */
  const NUMERIC = /^[\d_]+(\s*\*\s*[\d_]+)*$/;
  const millis = (expression: string) => expression.split("*").reduce((product, part) => product * Number(part.replace(/_/g, "").trim()), 1);

  /** Every per-test timeout the specs and the config declare, with where. */
  function declared(): Array<{ where: string; text: string }> {
    const found: Array<{ where: string; text: string }> = [];
    for (const file of files(E2E_DIR)) {
      const source = readFileSync(file, "utf8");
      const where = path.relative(REPO, file);
      for (const match of source.matchAll(/\btest\.setTimeout\(\s*([^)]*?)\s*\)/g)) found.push({ where, text: match[1] });
      for (const match of source.matchAll(/\bsetConfig\(\s*\{[^}]*?\btestTimeout\s*:\s*([^,}]*?)\s*[,}]/g)) found.push({ where, text: match[1] });
      for (const match of source.matchAll(/\bconfigure\(\s*\{[^}]*?\btimeout\s*:\s*([^,}]*?)\s*[,}]/g)) found.push({ where, text: match[1] });
    }
    const config = readFileSync(path.join(REPO, "playwright.config.ts"), "utf8");
    for (const match of config.matchAll(/^\s{2}timeout:\s*([^,]*?),/gm)) found.push({ where: "playwright.config.ts", text: match[1] });
    return found;
  }

  it("reads every declared timeout as a number (a constant or a sum would hide a long test from this guard)", () => {
    const found = declared();
    expect(found.length, "the scan found no timeout at all: it is broken").toBeGreaterThan(20);
    const unreadable = found.filter((d) => !NUMERIC.test(d.text));
    expect(unreadable.map((d) => `${d.where}: ${d.text}`), "write the timeout as a number, e.g. 420_000").toEqual([]);
  });

  it("DEFAULT_STALL_MS is greater than the largest of them (a test is silent between its start and its end)", () => {
    const found = declared().filter((d) => NUMERIC.test(d.text));
    const longest = found.reduce((a, b) => (millis(b.text) > millis(a.text) ? b : a));
    // The suite's longest today is the link crawl of navigation.spec.ts (900 s, @slow); the authored lifecycle and events-publish tests are 420 s.
    expect(millis(longest.text), `the longest declared timeout is ${longest.text} in ${longest.where}`).toBeGreaterThanOrEqual(420_000);
    expect(DEFAULT_STALL_MS, `a test of ${longest.text} ms (${longest.where}) would be ended as stalled`).toBeGreaterThan(millis(longest.text));
  });
});
