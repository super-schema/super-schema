// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { BEFORE_NAVIGATE_EVENT, beforeNavigateHref, canNavigate } from "@/lib/navigation/before-navigate";

const listeners: Array<(e: Event) => void> = [];
function listen(fn: (e: Event) => void) {
  listeners.push(fn);
  document.addEventListener(BEFORE_NAVIGATE_EVENT, fn);
}
afterEach(() => {
  while (listeners.length > 0) document.removeEventListener(BEFORE_NAVIGATE_EVENT, listeners.pop() as (e: Event) => void);
});

describe("canNavigate", () => {
  it("allows the navigation when nothing listens", () => {
    expect(canNavigate("/schemas/payments")).toBe(true);
  });

  it("tells the listeners where the shell is going", () => {
    const seen: Array<string | null> = [];
    listen((e) => seen.push(beforeNavigateHref(e)));
    expect(canNavigate("/schemas/payments?tab=events")).toBe(true);
    expect(seen).toEqual(["/schemas/payments?tab=events"]);
  });

  it("is false when a listener vetoes it, and every listener still sees the event", () => {
    const seen: string[] = [];
    listen((e) => { seen.push("first"); e.preventDefault(); });
    listen(() => seen.push("second"));
    expect(canNavigate("/schemas/payments")).toBe(false);
    expect(seen).toEqual(["first", "second"]);
  });
});

describe("beforeNavigateHref", () => {
  it("reads the destination of the event", () => {
    expect(beforeNavigateHref(new CustomEvent(BEFORE_NAVIGATE_EVENT, { detail: { href: "/a" } }))).toBe("/a");
  });

  it("is null for an event without a usable destination", () => {
    expect(beforeNavigateHref(new Event(BEFORE_NAVIGATE_EVENT))).toBeNull();
    expect(beforeNavigateHref(new CustomEvent(BEFORE_NAVIGATE_EVENT, { detail: null }))).toBeNull();
    expect(beforeNavigateHref(new CustomEvent(BEFORE_NAVIGATE_EVENT, { detail: { href: 3 } }))).toBeNull();
    expect(beforeNavigateHref(new CustomEvent(BEFORE_NAVIGATE_EVENT, { detail: { href: "" } }))).toBeNull();
  });
});
