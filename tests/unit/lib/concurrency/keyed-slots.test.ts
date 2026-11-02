import { describe, expect, it } from "vitest";
import { KeyedSlots } from "@/lib/concurrency/keyed-slots";

describe("KeyedSlots", () => {
  it("takes units for a key up to its capacity, and refuses the one over it at once, taking nothing", () => {
    const slots = new KeyedSlots(3);
    expect(slots.tryAcquire("a", 2)).not.toBeNull();
    expect(slots.tryAcquire("a", 2)).toBeNull();
    expect(slots.inUse("a")).toBe(2);
    expect(slots.tryAcquire("a", 1)).not.toBeNull();
    expect(slots.inUse("a")).toBe(3);
  });

  it("gives the units back on release, and a second release gives nothing more back", () => {
    const slots = new KeyedSlots(2);
    const release = slots.tryAcquire("a", 2)!;
    expect(slots.tryAcquire("a", 1)).toBeNull();
    release();
    release();
    expect(slots.inUse("a")).toBe(0);
    const later = slots.tryAcquire("a", 1)!;
    expect(later).not.toBeNull();
    // the stale second release above must not have freed the units of the new hold
    release();
    expect(slots.inUse("a")).toBe(1);
    later();
    expect(slots.inUse("a")).toBe(0);
  });

  it("keeps each key's share apart: one key at its capacity does not refuse another", () => {
    const slots = new KeyedSlots(1);
    expect(slots.tryAcquire("busy")).not.toBeNull();
    expect(slots.tryAcquire("busy")).toBeNull();
    expect(slots.tryAcquire("other")).not.toBeNull();
  });

  it("refuses a request larger than the whole capacity, and rejects a capacity or a unit count that is not a whole number of at least 1", () => {
    const slots = new KeyedSlots(4);
    expect(slots.tryAcquire("a", 5)).toBeNull();
    expect(slots.inUse("a")).toBe(0);
    expect(() => new KeyedSlots(0)).toThrow(RangeError);
    expect(() => new KeyedSlots(1.5)).toThrow(RangeError);
    expect(() => slots.tryAcquire("a", 0)).toThrow(RangeError);
  });
});
