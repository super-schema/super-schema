// @vitest-environment jsdom
// tests/unit/features/events/builder/use-leave-guard.test.tsx
// The in-app leave guard: what it intercepts while the draft is dirty and, as much, what it never touches (the page rewrites its own
// ?tab= / ?section= with history.replaceState and tab / section switches must not prompt). Two paths: where `window.navigation` exists
// (Chromium) a cancelable `navigate` listener, stubbed here with a minimal EventTarget; elsewhere the click interceptor plus a popstate
// sentinel. The click interceptor runs on both, so a next/link click is stopped before Next has rendered the new route.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => {
  const router = { push: h.push };
  return { useRouter: () => router };
});

import { useLeaveGuard } from "@/features/events/builder/use-leave-guard";
import { canNavigate } from "@/lib/navigation/before-navigate";

const HERE = "/schemas/payments/checkout/events/ev1";
const OTHER = "/schemas/payments";

function setup(dirty: boolean, queryKey?: string) {
  return renderHook(({ dirty: d }) => useLeaveGuard(d, { queryKey }), { initialProps: { dirty } });
}

/** `prevented` is read after the guard's capture listener ran and before this swallows jsdom's "navigation not implemented". */
function click(el: Element, init: MouseEventInit = {}) {
  let prevented = false;
  const probe = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
  document.addEventListener("click", probe);
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })); });
  document.removeEventListener("click", probe);
  return { prevented };
}

/** The shell asking the page whether it may navigate (inside act: the guard's answer is a state update). */
function ask(href: string): boolean {
  let allowed = true;
  act(() => { allowed = canNavigate(href); });
  return allowed;
}

function link(href: string, attrs: Record<string, string> = {}) {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  for (const [name, value] of Object.entries(attrs)) a.setAttribute(name, value);
  const inner = document.createElement("span");
  a.append(inner);
  document.body.append(a);
  return { a, inner };
}

class FakeNavigation extends EventTarget {
  currentEntry: { index: number } | null = { index: 4 };
  readonly navigateListeners = new Set<EventListenerOrEventListenerObject>();
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (type === "navigate" && callback) this.navigateListeners.add(callback);
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (type === "navigate" && callback) this.navigateListeners.delete(callback);
    super.removeEventListener(type, callback, options);
  }
}

function installNavigation(): FakeNavigation {
  const nav = new FakeNavigation();
  Object.defineProperty(window, "navigation", { configurable: true, value: nav });
  return nav;
}

interface NavigateInit {
  type?: "push" | "replace" | "reload" | "traverse";
  to: string;
  cancelable?: boolean;
  hashChange?: boolean;
  download?: string | null;
  index?: number;
  /** history.pushState & co (what `router.push` ends in), a hash change, a same-document traversal. */
  sameDocument?: boolean;
}
function navigate(nav: FakeNavigation, init: NavigateInit): Event {
  const event = new Event("navigate", { cancelable: init.cancelable ?? true });
  Object.assign(event, {
    navigationType: init.type ?? "push",
    hashChange: init.hashChange ?? false,
    downloadRequest: init.download ?? null,
    destination: { url: new URL(init.to, window.location.href).href, sameDocument: init.sameDocument ?? false, index: init.index ?? -1 },
  });
  act(() => { nav.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  h.push.mockClear();
  Reflect.deleteProperty(window, "navigation");
  window.history.replaceState(null, "", HERE);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "navigation");
  vi.restoreAllMocks();
});

describe("useLeaveGuard: opted-in view query protection", () => {
  it("cancels tab traversal before history moves; Stay preserves the entry and proceed replays its delta", () => {
    const nav = installNavigation();
    window.history.replaceState(null, "", `${HERE}?tab=editor&keep=1`);
    const replace = vi.spyOn(window.history, "replaceState");
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const { result } = setup(true, "tab");
    const destination = `${HERE}?tab=schemas&keep=1`;
    expect(navigate(nav, { type: "traverse", to: destination, index: 3, sameDocument: true }).defaultPrevented).toBe(true);
    act(() => result.current.pending?.stay());
    expect(window.location.search).toBe("?tab=editor&keep=1");
    expect(replace).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    navigate(nav, { type: "traverse", to: destination, index: 3, sameDocument: true });
    act(() => result.current.pending?.proceed());
    expect(go).toHaveBeenCalledExactlyOnceWith(-1);
  });
  it("guards a different tab link but allows unrelated query changes in the same view", () => {
    installNavigation();
    window.history.replaceState(null, "", `${HERE}?tab=editor`);
    const { result } = setup(true, "tab");
    expect(click(link(`${HERE}?tab=editor&keep=1`).a).prevented).toBe(false);
    expect(result.current.pending).toBeNull();
    expect(click(link(`${HERE}?tab=schemas`).a).prevented).toBe(true);
    expect(result.current.pending?.destination).toBe(`${HERE}?tab=schemas`);
  });
});

describe("useLeaveGuard: link clicks (every browser)", () => {
  it("leaves everything alone while the draft is clean", () => {
    const { result } = setup(false);
    const { inner } = link(OTHER);
    expect(click(inner).prevented).toBe(false);
    expect(result.current.pending).toBeNull();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("cancels a click on a link to another page and asks, without navigating", () => {
    const { result } = setup(true);
    const { inner } = link(`${OTHER}?tab=events`);
    expect(click(inner).prevented).toBe(true); // a click on an element INSIDE the link counts
    expect(result.current.pending?.destination).toBe(`${OTHER}?tab=events`);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("names a same-site absolute href by its path", () => {
    const { result } = setup(true);
    click(link(`${window.location.origin}${OTHER}#top`).a);
    expect(result.current.pending?.destination).toBe(`${OTHER}#top`);
  });

  it("still asks for a link with target=_self", () => {
    const { result } = setup(true);
    expect(click(link(OTHER, { target: "_self" }).a).prevented).toBe(true);
    expect(result.current.pending).not.toBeNull();
  });

  it.each([
    ["a ctrl-click (new tab)", OTHER, {}, { ctrlKey: true }],
    ["a meta-click (new tab)", OTHER, {}, { metaKey: true }],
    ["a shift-click (new window)", OTHER, {}, { shiftKey: true }],
    ["an alt-click (download)", OTHER, {}, { altKey: true }],
    ["a middle click", OTHER, {}, { button: 1 }],
    ["a right click", OTHER, {}, { button: 2 }],
    ["a link that opens in another tab", OTHER, { target: "_blank" }, {}],
    ["a download link", OTHER, { download: "orders.json" }, {}],
    ["a link to this very page", HERE, {}, {}],
    ["a link to this page with another query (the page rewrites its own)", `${HERE}?tab=docs&section=servers`, {}, {}],
    ["a hash-only link", "#servers", {}, {}],
    ["a link to another site", "https://example.com/x", {}, {}],
    ["a mailto link", "mailto:team@example.com", {}, {}],
  ] as const)("does not ask for %s", (_name, href, attrs, init) => {
    const { result } = setup(true);
    expect(click(link(href, attrs).a, init).prevented).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it("does not touch a click that is not on a link", () => {
    const { result } = setup(true);
    const button = document.createElement("button");
    document.body.append(button);
    expect(click(button).prevented).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it("proceed() navigates exactly once, to the destination", () => {
    const { result } = setup(true);
    click(link(`${OTHER}?tab=events`).a);
    const { pending } = result.current;
    act(() => { pending?.proceed(); });
    act(() => { pending?.proceed(); });
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith(`${OTHER}?tab=events`);
    expect(result.current.pending).toBeNull();
  });

  it("proceed() switches the guard off before it navigates (dirty only changes after a re-render)", () => {
    const { result } = setup(true);
    const { a } = link(OTHER);
    click(a);
    act(() => { result.current.pending?.proceed(); });
    expect(click(a).prevented).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it("stay() closes the question and keeps guarding", () => {
    const { result } = setup(true);
    const { a } = link(OTHER);
    click(a);
    act(() => { result.current.pending?.stay(); });
    expect(result.current.pending).toBeNull();
    expect(h.push).not.toHaveBeenCalled();
    expect(click(a).prevented).toBe(true);
    expect(result.current.pending?.destination).toBe(OTHER);
  });

  it("stay() after proceed() (and the other way round) does nothing", () => {
    const { result } = setup(true);
    click(link(OTHER).a);
    const { pending } = result.current;
    act(() => { pending?.stay(); });
    act(() => { pending?.proceed(); });
    expect(h.push).not.toHaveBeenCalled();
  });

  it("stops guarding on unmount", () => {
    const { unmount } = setup(true);
    const { a } = link(OTHER);
    unmount();
    expect(click(a).prevented).toBe(false);
    expect(canNavigate(OTHER)).toBe(true);
  });

  it("stops guarding, and forgets the question, when the draft stops being dirty (saved or discarded elsewhere)", () => {
    const { result, rerender } = setup(true);
    const { a } = link(OTHER);
    click(a);
    expect(result.current.pending).not.toBeNull();
    rerender({ dirty: false });
    expect(result.current.pending).toBeNull();
    expect(click(a).prevented).toBe(false);
    rerender({ dirty: true });
    expect(result.current.pending).toBeNull(); // the old question does not come back
    expect(click(a).prevented).toBe(true);
  });
});

describe("useLeaveGuard: the shell's own navigation (explorer rows push programmatically)", () => {
  it("vetoes it while dirty and asks", () => {
    const { result } = setup(true);
    expect(ask("/schemas/payments/checkout")).toBe(false);
    expect(result.current.pending?.destination).toBe("/schemas/payments/checkout");
    expect(h.push).not.toHaveBeenCalled();
    act(() => { result.current.pending?.proceed(); });
    expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout");
  });

  it("lets it through while clean", () => {
    const { result } = setup(false);
    expect(ask(OTHER)).toBe(true);
    expect(result.current.pending).toBeNull();
  });

  it("lets it through when it stays on this page (another query or hash)", () => {
    const { result } = setup(true);
    expect(ask(`${HERE}?tab=docs`)).toBe(true);
    expect(ask(`${HERE}#x`)).toBe(true);
    expect(result.current.pending).toBeNull();
  });

  it("lets it through once proceed() has switched the guard off", () => {
    const { result } = setup(true);
    ask(OTHER);
    act(() => { result.current.pending?.proceed(); });
    expect(ask(OTHER)).toBe(true);
  });
});

describe("useLeaveGuard: Back and Forward without the Navigation API (popstate sentinel)", () => {
  it("pushes one sentinel entry while dirty, and none while clean", () => {
    const push = vi.spyOn(window.history, "pushState");
    setup(false);
    expect(push).not.toHaveBeenCalled();
    const { rerender } = setup(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[2]).toBeUndefined(); // same URL: only a history entry
    rerender({ dirty: false });
    rerender({ dirty: true });
    expect(push).toHaveBeenCalledTimes(1); // still on the sentinel entry: never stacked
  });

  it("does not stack a second sentinel when the page rewrites the URL between dirty toggles (replaceState drops what history.state held)", () => {
    const push = vi.spyOn(window.history, "pushState");
    const { rerender } = setup(true);
    expect(push).toHaveBeenCalledTimes(1);
    // The page rewrites ?tab= / ?section= with replaceState; Next's patched replaceState replaces the entry's state, marker included.
    window.history.replaceState(null, "", `${HERE}?tab=docs`);
    expect(window.history.state).toBeNull();
    rerender({ dirty: false });
    rerender({ dirty: true });
    rerender({ dirty: false });
    window.history.replaceState(null, "", `${HERE}?tab=code`);
    rerender({ dirty: true });
    expect(push).toHaveBeenCalledTimes(1); // the sentinel is still the entry behind us
  });

  it("pushes a fresh sentinel when the user went back while the draft was clean (the sentinel is no longer the current entry)", () => {
    const push = vi.spyOn(window.history, "pushState");
    const { rerender } = setup(true);
    expect(push).toHaveBeenCalledTimes(1);
    rerender({ dirty: false });
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); }); // Back while clean: nothing asks, we are on the page's own entry again
    rerender({ dirty: true });
    expect(push).toHaveBeenCalledTimes(2); // Back must be caught again
  });

  it("asks on popstate, puts the sentinel back, and proceed() goes past both entries", () => {
    const push = vi.spyOn(window.history, "pushState");
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const { result } = setup(true);
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(push).toHaveBeenCalledTimes(2);
    expect(result.current.pending).not.toBeNull();
    expect(result.current.pending?.destination).toBe(""); // the browser does not say where Back goes
    act(() => { result.current.pending?.proceed(); });
    expect(go).toHaveBeenCalledWith(-2);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("asks again after Stay", () => {
    const { result } = setup(true);
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    act(() => { result.current.pending?.stay(); });
    expect(result.current.pending).toBeNull();
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(result.current.pending).not.toBeNull();
  });

  it("ignores popstate while clean and after unmount", () => {
    const push = vi.spyOn(window.history, "pushState");
    const clean = setup(false);
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(clean.result.current.pending).toBeNull();
    const dirty = setup(true);
    dirty.unmount();
    const calls = push.mock.calls.length;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(push.mock.calls.length).toBe(calls);
  });
});

describe("useLeaveGuard: the Navigation API path", () => {
  it("listens for `navigate` only while dirty, and adds no history entry", () => {
    const nav = installNavigation();
    const push = vi.spyOn(window.history, "pushState");
    const { rerender, unmount } = setup(false);
    expect(nav.navigateListeners.size).toBe(0);
    rerender({ dirty: true });
    expect(nav.navigateListeners.size).toBe(1);
    expect(push).not.toHaveBeenCalled();
    rerender({ dirty: false });
    expect(nav.navigateListeners.size).toBe(0);
    rerender({ dirty: true });
    expect(nav.navigateListeners.size).toBe(1);
    unmount();
    expect(nav.navigateListeners.size).toBe(0);
  });

  it("cancels a navigation to another page and asks", () => {
    const nav = installNavigation();
    const { result } = setup(true);
    const event = navigate(nav, { to: `${OTHER}?tab=events` });
    expect(event.defaultPrevented).toBe(true);
    expect(result.current.pending?.destination).toBe(`${OTHER}?tab=events`);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("lets a clean draft navigate", () => {
    const nav = installNavigation();
    const { result } = setup(false);
    expect(navigate(nav, { to: OTHER }).defaultPrevented).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it.each([
    ["a replace (the page rewrites ?tab= / ?section= with replaceState)", { type: "replace", to: `${HERE}?tab=docs` }],
    ["a replace to another page", { type: "replace", to: OTHER }],
    ["a push to this page with another query", { to: `${HERE}?section=servers` }],
    ["a push to this page with another hash", { to: `${HERE}#servers` }],
    ["a hash change", { to: "#servers", hashChange: true }],
    ["a download", { to: "/api/export/orders.json", download: "orders.json" }],
    ["a reload", { type: "reload", to: HERE }],
    ["a navigation the browser does not let the page cancel", { to: OTHER, cancelable: false }],
  ] as const satisfies ReadonlyArray<readonly [string, NavigateInit]>)("never prompts for %s", (_name, init) => {
    const nav = installNavigation();
    const { result } = setup(true);
    expect(navigate(nav, init).defaultPrevented).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it("leaves a same-document push alone: that is `router.push` calling history.pushState after the new route rendered", () => {
    const nav = installNavigation();
    const { result } = setup(true);
    // Cancelling it would not stop the navigation (pushState just does nothing): the new page would show under the old URL, without this one.
    expect(navigate(nav, { to: OTHER, sameDocument: true }).defaultPrevented).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it("still cancels a same-document traversal (Back to another page of the app)", () => {
    const nav = installNavigation();
    const { result } = setup(true);
    expect(navigate(nav, { type: "traverse", to: OTHER, sameDocument: true, index: 3 }).defaultPrevented).toBe(true);
    expect(result.current.pending).not.toBeNull();
  });

  it("asks for a navigation to another site, naming the full address", () => {
    const nav = installNavigation();
    const { result } = setup(true);
    expect(navigate(nav, { to: "https://example.com/docs" }).defaultPrevented).toBe(true);
    expect(result.current.pending?.destination).toBe("https://example.com/docs");
  });

  it("proceed() navigates once and switches the guard off first", () => {
    const nav = installNavigation();
    const { result } = setup(true);
    navigate(nav, { to: OTHER });
    const { pending } = result.current;
    act(() => { pending?.proceed(); });
    act(() => { pending?.proceed(); });
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith(OTHER);
    // The navigation proceed() starts raises its own `navigate`: it must not be caught again.
    expect(navigate(nav, { to: OTHER }).defaultPrevented).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it("stay() clears the question and keeps guarding", () => {
    const nav = installNavigation();
    const { result } = setup(true);
    navigate(nav, { to: OTHER });
    act(() => { result.current.pending?.stay(); });
    expect(result.current.pending).toBeNull();
    expect(navigate(nav, { to: OTHER }).defaultPrevented).toBe(true);
  });

  it("cancels Back and, once confirmed, goes back by the same number of entries", () => {
    const nav = installNavigation();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const { result } = setup(true);
    const event = navigate(nav, { type: "traverse", to: OTHER, index: 2 }); // current entry is 4
    expect(event.defaultPrevented).toBe(true);
    expect(result.current.pending?.destination).toBe(OTHER);
    act(() => { result.current.pending?.proceed(); });
    expect(go).toHaveBeenCalledWith(-2);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("goes forward by the right number of entries, and back one when the browser does not say", () => {
    const nav = installNavigation();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const first = setup(true);
    navigate(nav, { type: "traverse", to: OTHER, index: 5 });
    act(() => { first.result.current.pending?.proceed(); });
    expect(go).toHaveBeenCalledWith(1);
    first.unmount();

    nav.currentEntry = null;
    const second = setup(true);
    navigate(nav, { type: "traverse", to: OTHER, index: 5 });
    act(() => { second.result.current.pending?.proceed(); });
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("does not prompt for Back to an entry of this same page", () => {
    const nav = installNavigation();
    const { result } = setup(true);
    expect(navigate(nav, { type: "traverse", to: `${HERE}?tab=docs`, index: 3 }).defaultPrevented).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it("still stops a click on a link before the router sees it", () => {
    installNavigation();
    const { result } = setup(true);
    expect(click(link(OTHER).a).prevented).toBe(true);
    expect(result.current.pending?.destination).toBe(OTHER);
    act(() => { result.current.pending?.proceed(); });
    expect(h.push).toHaveBeenCalledWith(OTHER);
  });
});
