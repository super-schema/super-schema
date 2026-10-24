/**
 * scripts/e2e-process.mjs: how the suite's scripts start, signal and end a child. What is pinned is what went wrong without it: a signal
 * forwarded twice (the terminal had already sent it to the whole group), a signal to a child that has workers (only the leader got
 * it), and a child that ignores SIGTERM and is never ended.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createInterrupt, exitCodeForSignal, signalGroup, spawnGroup, terminateGroup } from "../../../scripts/e2e-process.mjs";

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

  it("says false for a child that never started or is gone (ESRCH), and rethrows any other error", () => {
    const kill = vi.fn();
    expect(signalGroup({}, "SIGINT", { kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    const gone = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(signalGroup({ pid: 1 }, "SIGINT", { kill: gone, platform: "linux" })).toBe(false);
    const denied = vi.fn(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(() => signalGroup({ pid: 1 }, "SIGINT", { kill: denied, platform: "linux" })).toThrow("not permitted");
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
    const interrupt = createInterrupt({ forward, force, ...t });
    interrupt.handle("SIGINT");
    interrupt.handle("SIGINT");
    interrupt.handle("SIGHUP");
    interrupt.handle("SIGTERM");
    expect(forward).toHaveBeenCalledTimes(1);
    expect(force).toHaveBeenCalledTimes(1);
    expect(t.timers[0].cleared).toBe(true);
    expect(interrupt.signal).toBe("SIGINT"); // the first one is what the run reports
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
