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
// The same module holds the STALL WATCHDOG (`watchForStall`, `stopStalledChild`): a child that stops making progress is ended whatever the
// cause. A run of Playwright that never ends, with every worker idle, was seen on Node 26.3.1; the watchdog does not know why a run
// hangs, only that nothing has finished for a long time (see `scripts/e2e-node.mjs` for the guard that keeps that Node away).
//
// Dependency-free, and unit tested (tests/unit/scripts/e2e-process.test.ts) with fake `kill` / timers / children.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

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
 * The pids below `pid` right now (`ps`), or none where `ps` cannot be read. Asked BEFORE the leader is ended: once it has gone its
 * children are reparented and no longer found below it.
 *
 * @param {number} pid
 * @param {{ listProcesses?: () => string, platform?: string }} [deps]
 */
export function treeBelow(pid, { listProcesses = () => execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5000 }), platform = process.platform } = {}) {
  if (platform === "win32") return [];
  try {
    return descendantsOf(listProcesses(), pid);
  } catch {
    return []; // no `ps`: the process alone
  }
}

/**
 * SIGKILL for `pid` and everything below it, the deepest first. The last resort of a step that did not stop: a step that starts
 * children of its own, each the leader of its own group (the phases script and Playwright), is not ended by a signal to one group.
 * Never throws: a process that is already gone is what was wanted, and where `ps` cannot be read it kills the process alone.
 *
 * @param {number} pid
 * @param {{ listProcesses?: () => string, kill?: (pid: number, signal: string) => void, platform?: string }} [deps]
 */
export function killTree(pid, { listProcesses, kill = process.kill, platform = process.platform } = {}) {
  const below = treeBelow(pid, { listProcesses, platform });
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

// ------------------------------------------------------------------------------------------------------------------------------------
// The stall watchdog
// ------------------------------------------------------------------------------------------------------------------------------------

/** What `timeout(1)` answers for a command it had to end; the phases script exits with it when the watchdog ended Playwright. */
export const STALL_EXIT_CODE = 124;

/**
 * No heartbeat for this long and the child is stalled. The heartbeat moves when a test starts or ends, so a test that is running is silent
 * for as long as it runs: the limit must be above the longest per-test timeout the suite declares (the link crawl of navigation.spec.ts is
 * 900 s, @slow; the authored lifecycle and events-publish tests are 420 s; the default is 60 s). tests/unit/scripts/e2e-process.test.ts scans
 * tests/e2e for every `test.setTimeout(` / `timeout:` and fails when this is not above the largest, so the two cannot drift.
 */
export const DEFAULT_STALL_MS = 20 * 60 * 1000;

/** How often the heartbeat is looked at. */
export const POLL_MS = 15_000;

/**
 * A number of milliseconds from an environment value: undefined when it is not set (or empty), else a positive whole number. Anything else
 * is an error that names the variable (a typo must not silently mean "no watchdog").
 *
 * @param {string} name
 * @param {string | undefined} raw
 * @returns {number | undefined}
 */
export function parseMillis(name, raw) {
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive whole number of milliseconds (got "${raw}")`);
  return Number(raw);
}

/** How often to look for a heartbeat when a stall is `stallMs`: every 15 s, and often enough that a short limit (a test of the watchdog) is not overshot by much. */
export const pollMsFor = (stallMs) => Math.max(250, Math.min(POLL_MS, Math.floor(stallMs / 4)));

/** "20 s", "5 min", "1.5 min": for the message of a stall. */
export function formatDuration(ms) {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`;
}

/**
 * The heartbeat file as the watchdog reads it: its modification time and its text, or undefined when there is none (yet). Never throws.
 *
 * @param {string} file
 * @param {{ stat?: (file: string) => { mtimeMs: number }, read?: (file: string) => string }} [deps]
 * @returns {{ mtimeMs: number, text: string } | undefined}
 */
export function readHeartbeat(file, { stat = statSync, read = (f) => readFileSync(f, "utf8") } = {}) {
  try {
    return { mtimeMs: stat(file).mtimeMs, text: read(file) };
  } catch {
    return undefined;
  }
}

/** A gap between two polls longer than this many poll periods is a machine that slept (or a process that was stopped), not a run that stalled. */
export const SLEEP_JUMP_FACTOR = 4;

/**
 * Looks at a heartbeat every `pollMs` and calls `onStall` once when the run has shown no sign of life for `stallMs`. The watch ends by
 * itself after it fired; `stop()` ends it earlier (the child exited). It does NOT stop when the heartbeat says the run has ended: a run
 * that hangs after its last test is the case it is for.
 *
 * Time is measured on a MONOTONIC clock (`now`, default `performance.now()`), never by comparing the wall clock with the heartbeat's
 * modification time: a laptop that slept for longer than the limit has a heartbeat that is hours old by the wall clock, and the first
 * poll after the wake-up used to end a healthy run, blaming Node and Playwright. So:
 *   - a sign of life is the heartbeat's modification time CHANGING (a value that differs from the last one seen, and is not from before
 *     the watch began: a file of an earlier run); the idle time is the monotonic time since it last changed (or since the watch began);
 *   - a gap between two polls of more than SLEEP_JUMP_FACTOR poll periods is a sleep: the idle time starts again from that poll
 *     (`onSleep(gapMs)` is told, so a log can say so) instead of firing. A real stall is still found, one limit after the wake-up.
 *
 * @param {{ stallMs: number, pollMs?: number, readHeartbeat: () => ({ mtimeMs: number, text: string } | undefined),
 *   onStall: (info: { idleMs: number, ended: boolean }) => void, onSleep?: (gapMs: number) => void,
 *   now?: () => number, wallNow?: () => number, setTimer?: Function, clearTimer?: Function }} options
 * @returns {{ stop: () => void, readonly stalled: boolean }}
 */
export function watchForStall({
  stallMs,
  pollMs = POLL_MS,
  readHeartbeat: read,
  onStall,
  onSleep,
  now = () => performance.now(),
  wallNow = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  // A file system rounds a modification time (HFS+ to the second): a beat of this run is never older than the watch by more than that.
  const startedWall = wallNow() - 2000;
  let lastSignOfLifeAt = now();
  let lastPollAt = lastSignOfLifeAt;
  /** @type {number | undefined} */
  let lastMtime;
  let fired = false;
  const timer = setTimer(() => {
    if (fired) return;
    const at = now();
    const gapMs = at - lastPollAt;
    lastPollAt = at;
    if (gapMs > SLEEP_JUMP_FACTOR * pollMs) {
      lastSignOfLifeAt = at;
      onSleep?.(gapMs);
      return;
    }
    const beat = read();
    if (beat && beat.mtimeMs !== lastMtime && beat.mtimeMs >= startedWall) {
      lastMtime = beat.mtimeMs;
      lastSignOfLifeAt = at;
    }
    const idleMs = at - lastSignOfLifeAt;
    if (idleMs < stallMs) return;
    fired = true;
    clearTimer(timer);
    onStall({ idleMs, ended: beat?.text.startsWith("end") ?? false });
  }, pollMs);
  timer?.unref?.();
  return {
    stop: () => clearTimer(timer),
    get stalled() {
      return fired;
    },
  };
}

/**
 * Ends a stalled child and what it left behind: SIGTERM to its group (SIGKILL after `graceMs`), and SIGKILL for everything that was below
 * it when this was called (workers and browsers are not all in the child's group, and a leader that dies on SIGTERM reparents them, so
 * the tree is read first). Never rejects.
 *
 * @param {import("node:events").EventEmitter & { pid?: number, exitCode?: number | null, signalCode?: string | null }} child
 * @param {{ graceMs?: number, listProcesses?: () => string, kill?: Function, platform?: string, setTimer?: Function, clearTimer?: Function }} [options]
 * @returns {Promise<void>}
 */
export async function stopStalledChild(child, { graceMs = 5000, listProcesses, kill = process.kill, platform = process.platform, setTimer, clearTimer } = {}) {
  const below = child.pid === undefined ? [] : treeBelow(child.pid, { listProcesses, platform });
  await terminateGroup(child, { graceMs, kill, platform, setTimer, clearTimer });
  for (const pid of below.reverse()) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
