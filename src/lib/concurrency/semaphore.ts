/**
 * A counting semaphore for async work: at most `limit` tasks hold a slot at once, and the rest wait in arrival order. A waiting task is
 * queued, not refused, unless the waiting line itself is full (`maxWaiting`): then it is refused at once with `SemaphoreFullError`, so the
 * memory and the open requests behind a queue stay bounded under a flood.
 *
 * A slot is released on every way a task can end (its result, its error, a timeout or an abort inside it) because the release is in a
 * `finally`. The slot passes straight to the next waiter, so a task that arrives after a release cannot take the slot that was promised.
 *
 * A task waiting for a slot can also leave the line: when its signal aborts (its caller went away), or when it waited longer than its
 * `maxWaitMs`. Either way it leaves at once, so it stops counting as waiting and gives its place to the tasks behind it.
 *
 * Process-local: it bounds the work of this process only. It has no timeout of its own for a running task: a task that never settles keeps
 * its slot, so a task that can hang must bound itself (the `tsp` runs time out, src/lib/typespec-official/emitter.service.ts).
 */

/** Refused by a semaphore whose waiting line is full: the task never ran and holds nothing. */
export class SemaphoreFullError extends Error {
  constructor(readonly waiting: number) {
    super(`${waiting} tasks are already waiting for a slot`);
    this.name = "SemaphoreFullError";
  }
}

/** Refused by a task that gave up its place in the line: its signal aborted (the caller went away) before it got a slot. It never ran. */
export class SemaphoreCancelledError extends Error {
  constructor() {
    super("The task was cancelled while it waited for a slot");
    this.name = "SemaphoreCancelledError";
  }
}

/** Refused by a task that waited longer than its `maxWaitMs` for a slot: it left the line and never ran. */
export class SemaphoreWaitTimeoutError extends Error {
  constructor(readonly maxWaitMs: number) {
    super(`No slot was free within ${maxWaitMs} ms`);
    this.name = "SemaphoreWaitTimeoutError";
  }
}

export interface SemaphoreOptions {
  /** How many tasks may wait for a slot at once. A task beyond that is refused with `SemaphoreFullError`. Default: no bound. */
  maxWaiting?: number;
}

export interface SemaphoreRunOptions {
  /**
   * Aborts the wait. A task whose signal is aborted before it gets a slot leaves the line at once (so it no longer counts as waiting) and
   * rejects with `SemaphoreCancelledError`; it takes no slot. An abort after the slot was granted changes nothing here: the task runs on.
   */
  signal?: AbortSignal;
  /**
   * The longest the task waits for a slot. Past it, the task leaves the line at once and rejects with `SemaphoreWaitTimeoutError`. The clock
   * stops when the slot is granted, so it never covers the task's own run. Default: no bound.
   */
  maxWaitMs?: number;
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly maxWaiting: number;

  constructor(
    readonly limit: number,
    options: SemaphoreOptions = {},
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`A semaphore needs a whole limit of at least 1, not ${limit}`);
    this.maxWaiting = options.maxWaiting ?? Number.POSITIVE_INFINITY;
  }

  /** Tasks holding a slot now. */
  get running(): number {
    return this.active;
  }

  /** Tasks waiting for a slot now. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Runs `task` when a slot is free and resolves with its result (or rejects with its error). The slot is taken or queued synchronously, so
   * the order of calls is the order of the queue. A task that leaves the line without a slot (see `SemaphoreRunOptions`) never runs.
   */
  async run<T>(task: () => Promise<T> | T, options: SemaphoreRunOptions = {}): Promise<T> {
    await this.acquire(options);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire({ signal, maxWaitMs }: SemaphoreRunOptions): Promise<void> {
    if (signal?.aborted) return Promise.reject(new SemaphoreCancelledError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(new SemaphoreFullError(this.waiting.length));
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Called once the task has its slot, or has left the line: from then on neither the abort nor the deadline applies.
      const settle = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const grant = (): void => {
        settle();
        resolve();
      };
      const leave = (error: Error): void => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        settle();
        reject(error);
      };
      const onAbort = (): void => leave(new SemaphoreCancelledError());
      this.waiting.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (maxWaitMs !== undefined) timer = setTimeout(() => leave(new SemaphoreWaitTimeoutError(maxWaitMs)), maxWaitMs);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    // The slot goes straight to the next waiter: `active` does not change.
    if (next) next();
    else this.active -= 1;
  }
}
