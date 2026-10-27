import { describe, expect, it } from "vitest";
import { nextTabIndex, scrollEdges } from "@/features/events/builder/sections/tab-nav";

describe("nextTabIndex", () => {
  it("moves right and left, wrapping at both ends", () => {
    expect(nextTabIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextTabIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextTabIndex(1, 3, "ArrowLeft")).toBe(0);
    expect(nextTabIndex(0, 3, "ArrowLeft")).toBe(2);
  });

  it("jumps to the first and the last with Home and End", () => {
    expect(nextTabIndex(1, 4, "Home")).toBe(0);
    expect(nextTabIndex(1, 4, "End")).toBe(3);
  });

  it("answers null for any other key, so the caller leaves the event alone", () => {
    expect(nextTabIndex(0, 3, "Tab")).toBeNull();
    expect(nextTabIndex(0, 3, "x")).toBeNull();
    expect(nextTabIndex(0, 3, "ArrowDown")).toBeNull();
  });

  it("answers null when there is nothing to move to", () => {
    expect(nextTabIndex(0, 0, "ArrowRight")).toBeNull();
    expect(nextTabIndex(0, 0, "Home")).toBeNull();
  });

  it("stays on the only tab", () => {
    expect(nextTabIndex(0, 1, "ArrowRight")).toBe(0);
    expect(nextTabIndex(0, 1, "ArrowLeft")).toBe(0);
  });
});

describe("scrollEdges", () => {
  it("says there is more on the right when scrolled to the start", () => {
    expect(scrollEdges({ scrollLeft: 0, clientWidth: 100, scrollWidth: 300 })).toEqual({ start: false, end: true });
  });

  it("says there is more on both sides in the middle", () => {
    expect(scrollEdges({ scrollLeft: 80, clientWidth: 100, scrollWidth: 300 })).toEqual({ start: true, end: true });
  });

  it("says there is more on the left when scrolled to the end", () => {
    expect(scrollEdges({ scrollLeft: 200, clientWidth: 100, scrollWidth: 300 })).toEqual({ start: true, end: false });
  });

  it("says nothing is hidden when the content fits", () => {
    expect(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toEqual({ start: false, end: false });
  });

  it("counts a sub-pixel overhang as fitting", () => {
    expect(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300.5 })).toEqual({ start: false, end: false });
    expect(scrollEdges({ scrollLeft: 199.5, clientWidth: 100, scrollWidth: 300 })).toEqual({ start: true, end: false });
  });
});
