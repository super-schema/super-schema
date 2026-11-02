import { describe, expect, it } from "vitest";
import { Semaphore, SemaphoreCancelledError, SemaphoreFullError, SemaphoreWaitTimeoutError } from "@/lib/concurrency/semaphore";

/** A task whose end the test decides: it holds its slot until `finish` (or `fail`) is called. */
function gated<T = string>() {
  let finish!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { promise, finish, fail };
}

/** Lets every pending microtask and timer-free continuation run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Semaphore: the limit", () => {
  it("never runs more tasks than its limit at once; the rest wait, and start in the order they arrived", async () => {
    const sem = new Semaphore(2);
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => gated<number>());
    const runs = gates.map((gate, i) =>
      sem.run(async () => {
        started.push(i);
        running += 1;
        peak = Math.max(peak, running);
        try {
          return await gate.promise;
        } finally {
          running -= 1;
        }
      }),
    );
    await settle();
    expect(started).toEqual([0, 1]);
    expect(sem.running).toBe(2);
    expect(sem.queued).toBe(3);

    // Finish one at a time: each release starts the next waiter, in order, and never more than two at once.
    for (let i = 0; i < 5; i++) {
      gates[i].finish(i);
      await settle();
    }
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(sem.running).toBe(0);
    expect(sem.queued).toBe(0);
  });

  it("a task that arrives right after a release does not overtake a task that was already waiting", async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const first = gated();
    const a = sem.run(async () => {
      order.push("a");
      return first.promise;
    });
    const b = sem.run(async () => {
      order.push("b");
    });
    first.finish("done");
    await a;
    // `a` has released: `b` now holds the slot, so `c`, which arrives in the same tick, must queue behind it.
    const c = sem.run(async () => {
      order.push("c");
    });
    await Promise.all([b, c]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("refuses a limit that is not a whole number of at least one", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Semaphore(limit), String(limit)).toThrow(RangeError);
    }
    expect(() => new Semaphore(1)).not.toThrow();
  });
});

describe("Semaphore: every way a task can end gives its slot back", () => {
  it("a task that rejects releases its slot, and the next waiting task runs", async () => {
    const sem = new Semaphore(1);
    const failing = sem.run(async () => {
      throw new Error("tsp exited with code 1");
    });
    const next = sem.run(async () => "second");
    await expect(failing).rejects.toThrow("tsp exited with code 1");
    expect(await next).toBe("second");
    expect(sem.running).toBe(0);
  });

  it("a task that throws synchronously (before its first await) releases its slot too", async () => {
    const sem = new Semaphore(1);
    const broken = sem.run((): Promise<string> => {
      throw new Error("could not build the workspace");
    });
    await expect(broken).rejects.toThrow("could not build the workspace");
    expect(await sem.run(async () => "after")).toBe("after");
    expect(sem.running).toBe(0);
  });

  it("a task killed by a timeout or an abort (a rejection of any kind) releases its slot", async () => {
    const sem = new Semaphore(1);
    const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" });
    const aborted = new DOMException("the run was aborted", "AbortError");
    await expect(sem.run(() => Promise.reject(killed))).rejects.toBe(killed);
    await expect(sem.run(() => Promise.reject(aborted))).rejects.toBe(aborted);
    expect(await sem.run(async () => "still working")).toBe("still working");
    expect(sem.running).toBe(0);
  });

  it("releases the slot exactly once per task, so a finished task cannot free a slot that belongs to a waiter", async () => {
    const sem = new Semaphore(1);
    const holder = gated();
    const first = sem.run(() => holder.promise);
    const second = gated();
    const waiting = sem.run(() => second.promise);
    holder.finish("ok");
    await first;
    // The slot went to `waiting`; the count is one (that waiter), not zero.
    expect(sem.running).toBe(1);
    expect(sem.queued).toBe(0);
    second.finish("ok");
    await waiting;
    expect(sem.running).toBe(0);
  });
});

describe("Semaphore: a waiting task can leave the line", () => {
  it("a queued task whose signal aborts leaves the line at once, takes no slot and never runs", async () => {
    const sem = new Semaphore(1);
    const holder = gated();
    const running = sem.run(() => holder.promise);
    const caller = new AbortController();
    let ran = false;
    const queued = sem.run(
      async () => {
        ran = true;
      },
      { signal: caller.signal },
    );
    expect(sem.queued).toBe(1);

    caller.abort();
    // It is gone from the line at once, not when the slot would have reached it.
    expect(sem.queued).toBe(0);
    await expect(queued).rejects.toBeInstanceOf(SemaphoreCancelledError);
    expect(sem.running).toBe(1);

    holder.finish("done");
    await running;
    expect(ran).toBe(false);
    expect(sem.running).toBe(0);
  });

  it("the place a task gave up is free at once: the next task queues instead of being refused as full", async () => {
    const sem = new Semaphore(1, { maxWaiting: 1 });
    const holder = gated();
    const running = sem.run(() => holder.promise);
    const caller = new AbortController();
    const abandoned = sem.run(async () => "never", { signal: caller.signal });
    caller.abort();
    await expect(abandoned).rejects.toBeInstanceOf(SemaphoreCancelledError);

    const next = sem.run(async () => "next");
    expect(sem.queued).toBe(1);
    holder.finish("done");
    await running;
    expect(await next).toBe("next");
  });

  it("a task whose signal is already aborted is refused without queuing, and never runs", async () => {
    const sem = new Semaphore(1);
    const holder = gated();
    const running = sem.run(() => holder.promise);
    const caller = new AbortController();
    caller.abort();
    let ran = false;
    await expect(
      sem.run(
        async () => {
          ran = true;
        },
        { signal: caller.signal },
      ),
    ).rejects.toBeInstanceOf(SemaphoreCancelledError);
    expect(sem.queued).toBe(0);
    holder.finish("done");
    await running;
    expect(ran).toBe(false);
  });

  it("an abort after the slot was granted does not disturb the task that holds it, and the slot still goes back", async () => {
    const sem = new Semaphore(1);
    const caller = new AbortController();
    const holder = gated();
    const first = sem.run(() => holder.promise);
    const second = gated<string>();
    const granted = sem.run(() => second.promise, { signal: caller.signal });
    holder.finish("done");
    await first;
    expect(sem.running).toBe(1);
    caller.abort();
    expect(sem.running).toBe(1);
    second.finish("finished");
    expect(await granted).toBe("finished");
    expect(sem.running).toBe(0);
  });

  it("a task that waits longer than its maximum wait leaves the line with SemaphoreWaitTimeoutError; the tasks behind it keep their place", async () => {
    const sem = new Semaphore(1);
    const holder = gated();
    const running = sem.run(() => holder.promise);
    let impatientRan = false;
    const impatient = sem.run(
      async () => {
        impatientRan = true;
      },
      { maxWaitMs: 20 },
    );
    let patientRan = false;
    const patient = sem.run(async () => {
      patientRan = true;
      return "patient";
    });

    await expect(impatient).rejects.toBeInstanceOf(SemaphoreWaitTimeoutError);
    expect(sem.queued).toBe(1);
    holder.finish("done");
    await running;
    expect(await patient).toBe("patient");
    expect(impatientRan).toBe(false);
    expect(patientRan).toBe(true);
  });

  it("a task admitted before its maximum wait ends is not refused later: its deadline is cleared when it gets the slot", async () => {
    const sem = new Semaphore(1);
    const holder = gated();
    const running = sem.run(() => holder.promise);
    const admitted = sem.run(async () => "admitted", { maxWaitMs: 30 });
    holder.finish("done");
    await running;
    expect(await admitted).toBe("admitted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sem.running).toBe(0);
  });

  it("a task with no maximum wait waits as long as it takes", async () => {
    const sem = new Semaphore(1);
    const holder = gated();
    const running = sem.run(() => holder.promise);
    const waiting = sem.run(async () => "late");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sem.queued).toBe(1);
    holder.finish("done");
    await running;
    expect(await waiting).toBe("late");
  });
});

describe("Semaphore: a bounded queue", () => {
  it("refuses a task at once, with SemaphoreFullError, when the waiting line is full; the queued ones still run", async () => {
    const sem = new Semaphore(1, { maxWaiting: 1 });
    const holder = gated();
    const running = sem.run(() => holder.promise);
    const queued = sem.run(async () => "queued");
    await expect(sem.run(async () => "refused")).rejects.toBeInstanceOf(SemaphoreFullError);
    expect(sem.queued).toBe(1);
    holder.finish("done");
    await running;
    expect(await queued).toBe("queued");
  });

  it("with maxWaiting 0 nothing waits: a busy semaphore refuses the next task at once", async () => {
    const sem = new Semaphore(1, { maxWaiting: 0 });
    const holder = gated();
    const running = sem.run(() => holder.promise);
    await expect(sem.run(async () => "x")).rejects.toBeInstanceOf(SemaphoreFullError);
    holder.finish("done");
    await running;
    expect(await sem.run(async () => "free again")).toBe("free again");
  });

  it("a refused task never runs", async () => {
    const sem = new Semaphore(1, { maxWaiting: 0 });
    const holder = gated();
    const running = sem.run(() => holder.promise);
    let ran = false;
    await expect(
      sem.run(async () => {
        ran = true;
      }),
    ).rejects.toThrow(SemaphoreFullError);
    holder.finish("done");
    await running;
    expect(ran).toBe(false);
  });
});
