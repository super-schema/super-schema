"use client";

// src/features/events/builder/use-leave-guard.ts
// The in-app half of the unsaved-changes guard (closing or reloading the tab is `beforeunload` in use-event-draft). While `dirty`, whatever
// would take the user off this page is cancelled and turned into a question: `pending` is that question, `proceed()` leaves for real and
// `stay()` drops it. The page renders `UnsavedChangesDialog` from it.
//
//   Guarded:  a click on a same-site link (next/link, plain <a>), the shell's own navigation (`canNavigate`, the explorer rows), and
//             Back / Forward. Where the browser has the Navigation API (`window.navigation`, Chromium) a cancelable `navigate` event does
//             the Back / Forward part, and also catches document navigations (a link to another site, `location.assign`). Elsewhere
//             Back / Forward are caught with a popstate sentinel: while dirty one extra history entry for this same URL is pushed, a
//             popstate re-pushes it and asks, and leaving goes back past both entries (the sentinel stays in the history once the draft is
//             clean again).
//   Never:    a `replace` (the page rewrites ?tab= / ?section= / ?item= with history.replaceState), a navigation to this same pathname
//             (any query, any hash), a hash change, a download, a navigation the browser does not let the page cancel, modified clicks
//             and links that open elsewhere (new tab, `target`, `download`). Tab and section switches inside the page must never prompt.
//
// Why clicks are stopped BEFORE the router: next/link and the explorer navigate with `router.push`, and Next renders the new route first
// and calls history.pushState afterwards (in an insertion effect of the same commit). A `navigate` listener that cancels THAT push finds
// the new page already on screen under the old URL and this page, with its draft, unmounted (cancelling pushState is a silent no-op). So
// the click interceptor runs on both paths, the shell asks first (`canNavigate`), and the `navigate` listener leaves same-document pushes
// alone: it is the net for what cancels cleanly (Back / Forward, document navigations). A programmatic `router.push` from any other
// place (the command palette, a shortcut) is not guarded, in any browser: it would have to call `canNavigate` first, like the explorer.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BEFORE_NAVIGATE_EVENT, beforeNavigateHref } from "@/lib/navigation/before-navigate";

export interface PendingLeave {
  /** Where the user is going: a path ("/schemas/x?tab=y") for this site, the full address for another one, "" when the browser does not say (Back without the Navigation API). */
  destination: string;
  /** Leave for real. The guard is off before this navigates, so it is not caught again. Once only. */
  proceed(): void;
  /** Stay on the page. The guard keeps guarding. */
  stay(): void;
}

// ----- the slice of the Navigation API the guard reads (TypeScript's DOM lib does not declare it) -----
interface NavigateEventLike extends Event {
  readonly navigationType: "push" | "replace" | "reload" | "traverse";
  readonly hashChange: boolean;
  /** The file name when the navigation is a download, null otherwise. */
  readonly downloadRequest: string | null;
  readonly destination: {
    readonly url: string;
    /** True for history.pushState / replaceState, a hash change and a same-document traversal. */
    readonly sameDocument: boolean;
    /** Position in the history; only meaningful for a traversal. */
    readonly index: number;
  };
}
interface NavigationLike extends EventTarget {
  readonly currentEntry: { readonly index: number } | null;
}
function navigationApi(): NavigationLike | null {
  return (window as unknown as { navigation?: NavigationLike }).navigation ?? null;
}

/** Where `url` leads: `href` as the router wants it (a path for this site), and whether it stays on this very page (same origin and pathname). Null for an address that does not parse. */
function resolveTarget(url: string): { href: string; sameSite: boolean; staysHere: boolean } | null {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return null;
  }
  const sameSite = parsed.origin === window.location.origin;
  return {
    href: sameSite ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.href,
    sameSite,
    staysHere: sameSite && parsed.pathname === window.location.pathname,
  };
}

const SENTINEL_KEY = "__eventLeaveGuard";
const isSentinel = (state: unknown): boolean => typeof state === "object" && state !== null && SENTINEL_KEY in state;

/** `dirty` false → no listeners and `pending` stays null. */
export function useLeaveGuard(dirty: boolean): { pending: PendingLeave | null } {
  const router = useRouter();
  const [pending, setPending] = useState<PendingLeave | null>(null);

  useEffect(() => {
    if (!dirty) return;
    // `proceed` switches the guard off before it navigates: `dirty` only changes after a re-render, and the navigation it starts must not be caught again.
    let off = false;

    const ask = (destination: string, go: () => void) => {
      let settled = false;
      setPending({
        destination,
        proceed: () => {
          if (settled) return;
          settled = true;
          off = true;
          setPending(null);
          go();
        },
        stay: () => {
          if (settled) return;
          settled = true;
          setPending(null);
        },
      });
    };
    const askToGo = (href: string) => ask(href, () => router.push(href));

    // ----- every browser: a click on a same-site link, before the router sees it -----
    const onClick = (event: MouseEvent) => {
      if (off || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
      const frame = anchor.getAttribute("target");
      if (frame !== null && frame !== "" && frame !== "_self") return;
      const target = resolveTarget(anchor.href);
      // Another site is left to the Navigation API (Chromium) and beforeunload.
      if (target === null || !target.sameSite || target.staysHere) return;
      event.preventDefault();
      askToGo(target.href);
    };
    document.addEventListener("click", onClick, true);

    // ----- every browser: the shell's own navigation asks first (see before-navigate.ts) -----
    const onBeforeNavigate = (event: Event) => {
      const href = beforeNavigateHref(event);
      if (off || href === null) return;
      const target = resolveTarget(href);
      if (target === null || target.staysHere) return;
      event.preventDefault();
      askToGo(target.href);
    };
    document.addEventListener(BEFORE_NAVIGATE_EVENT, onBeforeNavigate);

    // ----- Back / Forward and the rest -----
    const nav = navigationApi();
    let removeHistoryGuard: () => void;
    if (nav) {
      const onNavigate = (event: Event) => {
        const e = event as NavigateEventLike;
        if (off || !e.cancelable || e.navigationType === "replace" || e.hashChange || typeof e.downloadRequest === "string") return;
        // A same-document push is `router.push` calling history.pushState after Next rendered the new route (see above): too late to stop.
        if (e.navigationType === "push" && e.destination.sameDocument) return;
        const target = resolveTarget(e.destination.url);
        if (target === null || target.staysHere) return;
        e.preventDefault();
        if (e.navigationType === "traverse") {
          // Confirmed: do the same traversal again, by the same number of entries.
          const delta = nav.currentEntry === null ? NaN : e.destination.index - nav.currentEntry.index;
          ask(target.href, () => (Number.isFinite(delta) && delta !== 0 ? window.history.go(delta) : window.history.back()));
        } else {
          askToGo(target.href);
        }
      };
      nav.addEventListener("navigate", onNavigate);
      removeHistoryGuard = () => nav.removeEventListener("navigate", onNavigate);
    } else {
      // Same URL, no `url` argument: only a history entry, which Back then lands on instead of leaving.
      if (!isSentinel(window.history.state)) window.history.pushState({ [SENTINEL_KEY]: true }, "");
      const onPopState = () => {
        if (off) return;
        window.history.pushState({ [SENTINEL_KEY]: true }, ""); // back on a sentinel, so the next Back asks again
        ask("", () => window.history.go(-2)); // past the page's own entry and the sentinel
      };
      window.addEventListener("popstate", onPopState);
      removeHistoryGuard = () => window.removeEventListener("popstate", onPopState);
    }

    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener(BEFORE_NAVIGATE_EVENT, onBeforeNavigate);
      removeHistoryGuard();
      setPending(null);
    };
  }, [dirty, router]);

  return { pending: dirty ? pending : null };
}
