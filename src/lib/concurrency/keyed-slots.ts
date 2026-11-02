/**
 * Capacity held per key (a user, an API principal): `tryAcquire(key, units)` takes `units` of that key's capacity when they fit and returns the
 * release; when they do not fit it takes nothing and returns null, at once. Nothing queues here: a caller over its share is refused, so a key that
 * is already busy cannot make the work of others wait behind it. Use it to bound one caller's share of a queue that is shared (the queue itself
 * is a `Semaphore`, src/lib/concurrency/semaphore.ts).
 *
 * The release is idempotent: calling it twice gives the units back once. Process-local, like the semaphore.
 */
export class KeyedSlots {
  private readonly held = new Map<string, number>();

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`A keyed capacity needs a whole number of at least 1, not ${capacity}`);
  }

  /** The units `key` holds now. */
  inUse(key: string): number {
    return this.held.get(key) ?? 0;
  }

  /** Takes `units` for `key` if they fit under the capacity; the release gives them back. Null: nothing was taken. */
  tryAcquire(key: string, units = 1): (() => void) | null {
    if (!Number.isInteger(units) || units < 1) throw new RangeError(`A keyed acquire needs a whole number of at least 1 unit, not ${units}`);
    const used = this.inUse(key);
    if (used + units > this.capacity) return null;
    this.held.set(key, used + units);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.inUse(key) - units;
      if (left > 0) this.held.set(key, left);
      else this.held.delete(key);
    };
  }
}
