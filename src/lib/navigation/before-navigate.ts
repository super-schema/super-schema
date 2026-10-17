// src/lib/navigation/before-navigate.ts
// A page with unsaved work needs a say before the SHELL navigates away. The explorer rows, the command palette, the new-entity shortcut and
// the notification list call `router.push` from a handler, and
// nothing can stop that once it has started: Next renders the new route first and only then calls history.pushState (a Navigation API
// listener that cancels it finds the new page already on screen, with the old URL). So a shell control asks first, with `canNavigate`,
// and does not navigate when it gets `false`; the page that vetoed owns asking the user. Plain `<a>` / next/link clicks, Back and Forward
// are the page's own business (`useLeaveGuard`). Pure DOM events, client-safe.
export const BEFORE_NAVIGATE_EVENT = "super-schema:before-navigate";

export interface BeforeNavigateDetail { href: string }

/** False when a listener (a page with unsaved changes) vetoed going to `href`; the caller must then not navigate. */
export function canNavigate(href: string): boolean {
  if (typeof document === "undefined") return true;
  return document.dispatchEvent(new CustomEvent<BeforeNavigateDetail>(BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { href } }));
}

/** Where the shell is going, read from a `BEFORE_NAVIGATE_EVENT`; null for an event that does not say. */
export function beforeNavigateHref(event: Event): string | null {
  const detail: unknown = event instanceof CustomEvent ? event.detail : null;
  if (typeof detail !== "object" || detail === null || !("href" in detail)) return null;
  const { href } = detail;
  return typeof href === "string" && href !== "" ? href : null;
}
