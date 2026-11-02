import { describe, expect, it } from "vitest";
import { dayAfterStart, dayInputValue, dayStart, lastDayInputValue, withDateBound } from "@/features/compliance/audit-date-range";

// The tests build their expectations with the LOCAL constructors, so they hold in whatever time zone the suite runs in.

describe("dayStart: the local midnight that starts the picked day", () => {
  it("is the local midnight of that day, not UTC midnight", () => {
    expect(dayStart("2026-10-31")).toEqual(new Date(2026, 9, 31, 0, 0, 0, 0));
  });

  it("is undefined for an empty value, a malformed one and a day that does not exist", () => {
    expect(dayStart("")).toBeUndefined();
    expect(dayStart("31/10/2026")).toBeUndefined();
    expect(dayStart("2026-02-30")).toBeUndefined();
    expect(dayStart("2026-13-01")).toBeUndefined();
  });

  it("reads the years 0-99 as the years they are, not as 1900-1999", () => {
    const date = dayStart("0050-03-01");
    expect(date?.getFullYear()).toBe(50);
  });
});

describe("dayAfterStart: the exclusive end of the picked day", () => {
  it("is the local midnight that starts the day after it", () => {
    expect(dayAfterStart("2026-10-31")).toEqual(new Date(2026, 10, 1, 0, 0, 0, 0));
    expect(dayAfterStart("2026-12-31")).toEqual(new Date(2027, 0, 1, 0, 0, 0, 0));
  });

  it("a moment late on the picked day is before it, and a moment on the next day is not", () => {
    const end = dayAfterStart("2026-10-31");
    expect(new Date(2026, 9, 31, 23, 59, 59, 999).getTime()).toBeLessThan(end!.getTime());
    expect(new Date(2026, 10, 1, 0, 0, 0, 0).getTime()).not.toBeLessThan(end!.getTime());
  });
});

describe("the input values", () => {
  it("a moment reads as the local day it falls on", () => {
    expect(dayInputValue(new Date(2026, 9, 31, 23, 30))).toBe("2026-10-31");
    expect(dayInputValue(new Date(2026, 0, 5, 0, 0))).toBe("2026-01-05");
    expect(dayInputValue(undefined)).toBe("");
  });

  it("the To input shows the last day of an exclusive end, so a picked day reads back as itself", () => {
    expect(lastDayInputValue(dayAfterStart("2026-10-31"))).toBe("2026-10-31");
    expect(lastDayInputValue(dayAfterStart("2026-02-28"))).toBe("2026-02-28");
    expect(lastDayInputValue(undefined)).toBe("");
  });

  it("a picked day round-trips through its range", () => {
    for (const day of ["2026-01-01", "2026-03-08", "2026-10-25", "2026-12-31"]) {
      expect(dayInputValue(dayStart(day))).toBe(day);
      expect(lastDayInputValue(dayAfterStart(day))).toBe(day);
    }
  });
});

describe("withDateBound: one bound changes, the other stays, and no bound is no filter", () => {
  const from = new Date(2026, 9, 1);
  const to = new Date(2026, 10, 1);

  it("sets a bound on an empty range", () => {
    expect(withDateBound(undefined, { from })).toEqual({ from });
    expect(withDateBound(undefined, { to })).toEqual({ to });
  });

  it("keeps the other bound: a From chosen alone invents no To", () => {
    expect(withDateBound(undefined, { from })).not.toHaveProperty("to");
  });

  it("clearing a bound keeps the other, and clearing both removes the range", () => {
    expect(withDateBound({ from, to }, { to: undefined })).toEqual({ from, to: undefined });
    expect(withDateBound({ from }, { from: undefined })).toBeUndefined();
    expect(withDateBound({ from, to }, { from: undefined, to: undefined })).toBeUndefined();
  });
});
