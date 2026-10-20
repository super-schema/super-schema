import { performance } from "node:perf_hooks";

/**
 * Starts a 10 ms timer and records the longest time the event loop of this process was kept from running it. `stop()` returns that, in ms,
 * and counts the time since the last tick too: a loop that is blocked until `stop()` is called never ticks again, and would read as "no lag".
 */
export function lagProbe(): { stop: () => number } {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 10);
    last = now;
  }, 10);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.max(max, performance.now() - last - 10);
    },
  };
}
