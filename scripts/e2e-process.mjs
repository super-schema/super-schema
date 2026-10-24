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

import { spawn } from "node:child_process";

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
 * nobody left to signal (ESRCH) or the child never started; any other error is thrown.
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
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
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
 * What a script does with signals while it waits for a child: the FIRST one is forwarded (once) and starts a grace period after which
 * the child is forced; a SECOND one (the user presses Ctrl-C again) forces it at once; more are ignored. The script itself exits when
 * the child has, so its own cleanup (login file, container, server) still runs: this only decides what reaches the child.
 *
 * @param {{ forward: (signal: string) => void, force: () => void, graceMs?: number, setTimer?: Function, clearTimer?: Function }} options
 */
export function createInterrupt({ forward, force, graceMs = 30_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let count = 0;
  let first;
  let timer;
  return {
    /** @param {string} signal */
    handle(signal) {
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
