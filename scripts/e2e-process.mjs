// Child processes for the browser suite's scripts (scripts/e2e-phases.mjs, scripts/e2e-release.mjs): one place for how a child is
// started, signalled and ended, so the two scripts cannot disagree.
//
// Why a child gets a process group of its own (POSIX): a terminal sends Ctrl-C (SIGINT) and a closed window (SIGHUP) to its whole
// foreground group, a `kill <pid>` or a CI cancel (SIGTERM) reaches one process only. A script that forwards a signal cannot tell which
// of the two it got, so it either forwarded twice (the terminal case) or not at all (the other). With the child as leader of its own
// group the terminal no longer reaches it behind the script's back: the script is the one place that decides, forwards the first signal
// once to the child's whole group (the child, its workers, the browsers), and escalates to SIGKILL on a second signal or after a grace
// period. Output still goes to the terminal (stdio is inherited); on Windows there are no groups and the child alone is signalled.
//
// Dependency-free, and unit tested (tests/unit/scripts/e2e-process.test.ts) with fake `kill` / timers / children.

import { execFileSync, spawn } from "node:child_process";

export const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The shell convention for a process ended by a signal: 128 + the signal number. */
export const SIGNAL_EXIT_CODE = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** Whether a child can lead a process group here. */
export const hasProcessGroups = (platform = process.platform) => platform !== "win32";

/** Starts a child as the leader of a new process group (POSIX), so that `signalGroup` reaches everything it starts. */
export function spawnGroup(command, args, options = {}) {
  return spawn(command, args, { ...options, detached: hasProcessGroups() });
}

/**
 * Sends `signal` to the child's whole group (the negative pid) on POSIX, to the child itself elsewhere. Returns false when there was
 * nobody left to signal or the child never started: ESRCH (no such process), and EPERM, which macOS answers for a group whose members
 * have all exited and only wait to be reaped (a group of our own children cannot be one we may not signal). Any other error is thrown.
 *
 * @param {{ pid?: number }} child
 * @param {string} signal
 * @param {{ kill?: (pid: number, signal: string) => void, platform?: string }} [deps]
 */
export function signalGroup(child, signal, { kill = process.kill, platform = process.platform } = {}) {
  if (child.pid === undefined) return false;
  try {
    kill(hasProcessGroups(platform) ? -child.pid : child.pid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")) return false;
    throw error;
  }
}

const hasExited = (child) => child.exitCode != null || child.signalCode != null;

/**
 * Ends a child's group: `signal` (SIGTERM) first, SIGKILL when it has not exited after `graceMs`, and a last SIGKILL at the group once
 * the leader is gone (a worker or a browser the leader left behind). Resolves when the leader has exited, or a moment after the SIGKILL
 * if it somehow has not. Never rejects.
 *
 * @param {import("node:events").EventEmitter & { pid?: number, exitCode?: number | null, signalCode?: string | null }} child
 * @param {{ signal?: string, graceMs?: number, kill?: Function, platform?: string, setTimer?: Function, clearTimer?: Function }} [options]
 * @returns {Promise<void>}
 */
export function terminateGroup(child, { signal = "SIGTERM", graceMs = 10_000, kill = process.kill, platform = process.platform, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const send = (sig) => signalGroup(child, sig, { kill, platform });
  return new Promise((resolve) => {
    if (child.pid === undefined || hasExited(child)) {
      send("SIGKILL"); // stragglers of a leader that has gone
      resolve();
      return;
    }
    let graceTimer;
    let giveUpTimer;
    child.once("exit", () => {
      clearTimer(graceTimer);
      clearTimer(giveUpTimer);
      send("SIGKILL");
      resolve();
    });
    send(signal);
    graceTimer = setTimer(() => {
      send("SIGKILL");
      giveUpTimer = setTimer(resolve, 2_000);
    }, graceMs);
  });
}

/**
 * The pids below `pid` in the process tree (children, grandchildren ...), from the output of `ps -A -o pid=,ppid=`: whatever process
 * group they are in, which a group signal does not follow (every child here leads a group of its own). Pure.
 *
 * @param {string} psOutput
 * @param {number} pid
 * @returns {number[]}
 */
export function descendantsOf(psOutput, pid) {
  const children = new Map();
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const [child, parent] = [Number(match[1]), Number(match[2])];
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * SIGKILL for `pid` and everything below it, the deepest first. The last resort of a step that did not stop: a step that starts
 * children of its own, each the leader of its own group (the phases script and Playwright), is not ended by a signal to one group.
 * Never throws: a process that is already gone is what was wanted, and where `ps` cannot be read it kills the process alone.
 *
 * @param {number} pid
 * @param {{ listProcesses?: () => string, kill?: (pid: number, signal: string) => void, platform?: string }} [deps]
 */
export function killTree(pid, { listProcesses = () => execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5000 }), kill = process.kill, platform = process.platform } = {}) {
  let below = [];
  if (platform !== "win32") {
    try {
      below = descendantsOf(listProcesses(), pid);
    } catch {
      // no `ps`: the process alone
    }
  }
  for (const target of [...below.reverse(), pid]) {
    try {
      kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * What a script does with signals while it waits for a child: the FIRST one is forwarded (once) and starts a grace period after which
 * the child is forced; a SECOND one forces it at once; more are ignored. A signal that follows another within `debounceMs` is the same
 * one (a terminal's Ctrl-C reaches the script, and npm, which runs it, forwards the signal it got: two within milliseconds; Playwright
 * debounces its SIGINT the same way), so only a deliberate second Ctrl-C escalates. The script itself exits when the child has, so its
 * own cleanup (login file, container, server) still runs: this only decides what reaches the child.
 *
 * @param {{ forward: (signal: string) => void, force: () => void, graceMs?: number, debounceMs?: number, now?: () => number, setTimer?: Function, clearTimer?: Function }} options
 */
export function createInterrupt({ forward, force, graceMs = 30_000, debounceMs = 1000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let count = 0;
  let first;
  let timer;
  let last = Number.NEGATIVE_INFINITY;
  return {
    /** @param {string} signal */
    handle(signal) {
      const at = now();
      if (at - last < debounceMs) return;
      last = at;
      count += 1;
      if (count === 1) {
        first = signal;
        forward(signal);
        timer = setTimer(force, graceMs);
        timer?.unref?.();
      } else if (count === 2) {
        clearTimer(timer);
        force();
      }
    },
    /** The signal that interrupted the run, or undefined. */
    get signal() {
      return first;
    },
    get interrupted() {
      return count > 0;
    },
    /** The run is over: no forced kill may fire afterwards. */
    done() {
      clearTimer(timer);
    },
  };
}

/** The exit code for a run stopped by `signal`. */
export const exitCodeForSignal = (signal) => SIGNAL_EXIT_CODE[signal] ?? 1;
