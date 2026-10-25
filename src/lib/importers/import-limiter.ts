/**
 * Admission control for the "From URL" schema import: a process-wide cap on how many imports run at once, and a per-user sliding window
 * on how many a user may start. An import fetches up to 20 MB and builds it into objects on the event loop (nine public 2 MB files took
 * 4.4 s and about 1 GB of heap), and any signed-in user may start one with any URL, so without this one user can hold the server.
 *
 * Deliberately small and in memory: ONE limiter per process (`urlImportLimiter`), keyed by user id. It does not coordinate several server
 * instances and it resets on restart. The database-backed limiter, shared by every instance and keyed by tenant and role, belongs to the
 * access-control project; the interface (`acquire(userId)` -> a slot to release, or a refusal that says how long to wait) is meant to
 * survive that swap. Injectable clock and limits, so tests need no timers.
 *
 * A refused attempt is never recorded: being turned away as busy costs the user nothing, and waiting out a rate refusal is enough.
 */

export interface ImportLimiterOptions {
  /** Imports that may run at once, process-wide. */
  maxConcurrent: number;
  /** Imports one user may START per window. */
  perUserLimit: number;
  /** The sliding window, in milliseconds. */
  windowMs?: number;
  /** Injectable clock (milliseconds). */
  now?: () => number;
  /** Once more users than this are tracked, every acquire first forgets the ones whose window has passed. */
  sweepAbove?: number;
}

export type ImportSlot =
  | { ok: true; release: () => void }
  | { ok: false; reason: "busy" | "rate"; retryAfterMs: number; message: string };

const BUSY_RETRY_MS = 5_000;

export class ImportLimiter {
  private readonly maxConcurrent: number;
  private readonly perUserLimit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sweepAbove: number;
  private running = 0;
  private readonly starts = new Map<string, number[]>();

  constructor(options: ImportLimiterOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent);
    this.perUserLimit = Math.max(1, options.perUserLimit);
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sweepAbove = options.sweepAbove ?? 5_000;
  }

  /** Imports running right now. */
  get active(): number {
    return this.running;
  }

  /** Users with at least one start in the tracked window (after the last sweep). */
  get trackedUsers(): number {
    return this.starts.size;
  }

  acquire(userId: string): ImportSlot {
    const now = this.now();
    if (this.starts.size > this.sweepAbove) this.sweep(now);

    const recent = (this.starts.get(userId) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.perUserLimit) {
      this.starts.set(userId, recent);
      const retryAfterMs = Math.max(1, recent[0]! + this.windowMs - now);
      const seconds = Math.ceil(retryAfterMs / 1000);
      return {
        ok: false,
        reason: "rate",
        retryAfterMs,
        message: `You have started too many schema imports in the last minute. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
      };
    }
    if (this.running >= this.maxConcurrent) {
      if (recent.length === 0) this.starts.delete(userId);
      else this.starts.set(userId, recent);
      return {
        ok: false,
        reason: "busy",
        retryAfterMs: BUSY_RETRY_MS,
        message: "The server is busy with other schema imports right now. Try again in a few seconds.",
      };
    }

    recent.push(now);
    this.starts.set(userId, recent);
    this.running += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.running = Math.max(0, this.running - 1);
      },
    };
  }

  private sweep(now: number): void {
    for (const [user, times] of this.starts) {
      const recent = times.filter((t) => t > now - this.windowMs);
      if (recent.length === 0) this.starts.delete(user);
      else this.starts.set(user, recent);
    }
  }
}

/** Process-wide limits of the URL import: two imports at once, ten starts per user per minute. */
export const URL_IMPORT_MAX_CONCURRENT = 2;
export const URL_IMPORT_PER_USER_LIMIT = 10;
export const urlImportLimiter = new ImportLimiter({ maxConcurrent: URL_IMPORT_MAX_CONCURRENT, perUserLimit: URL_IMPORT_PER_USER_LIMIT });
