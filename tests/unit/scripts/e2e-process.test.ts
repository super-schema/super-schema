/**
 * scripts/e2e-process.mjs: how the suite's scripts start, signal and end a child. What is pinned is what went wrong without it: a signal
 * forwarded twice (the terminal had already sent it to the whole group), a signal to a child that has workers (only the leader got
 * it), and a child that ignores SIGTERM and is never ended.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createInterrupt, descendantsOf, exitCodeForSignal, killTree, signalGroup, spawnGroup, terminateGroup } from "../../../scripts/e2e-process.mjs";

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
