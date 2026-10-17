// @vitest-environment jsdom
// tests/unit/components/events/event-page-leave-guard.test.tsx
// The in-app unsaved-changes guard as the Event page wires it: a dirty draft + a link click (or Back, or the shell's own navigation) asks
// Save & leave / Discard & leave / Stay; a clean draft never asks; a failed save keeps the user on the page with the error visible; tab and
// section switches never ask; a deleted event is left without a question. jsdom has no Navigation API, so this runs the click / popstate
// path; the `navigate` path is covered once with a stub, and in depth by use-leave-guard.test.tsx and the Playwright spec.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  refresh: vi.fn(), push: vi.fn(), invalidate: vi.fn(), toastSuccess: vi.fn(),
  update: vi.fn(), rename: vi.fn(), remove: vi.fn(), preview: vi.fn(),
  previewPublish: vi.fn(), publish: vi.fn(), listVersions: vi.fn(), readVersion: vi.fn(), listUsages: vi.fn(),
}));
vi.mock("next/navigation", () => {
  const router = { refresh: h.refresh, push: h.push };
  return { useRouter: () => router };
});
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: vi.fn() } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => h.invalidate }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  updateEventDocumentAction: h.update, renameEventAction: h.rename, deleteEventAction: h.remove, previewEventDocumentAction: h.preview,
  previewEventPublishAction: h.previewPublish, publishEventAction: h.publish, listEventVersionsAction: h.listVersions, readEventVersionAction: h.readVersion,
}));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: h.listUsages }));
vi.mock("@/features/events/event-specs/AsyncApiPreview", () => ({ AsyncApiPreview: () => <div data-testid="asyncapi-preview" /> }));

import { EventPage } from "@/features/events/event-page/EventPage";
import type { EventPageData } from "@/features/events/event-page/load-event-page";
import { assetHref } from "@/lib/navigation/asset-href";
import { canNavigate } from "@/lib/navigation/before-navigate";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import { ENTITY_OPTIONS, makeEvent, sampleDocument } from "./builder-harness";

// The "+ Add" chooser and the dialogs measure and scroll; jsdom does neither.
globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;

const LIST_HREF = assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" });
const EVENT_URL = assetHref({ kind: "event", id: "ev1", domainSlug: "payments", productSlug: "checkout" });
const ENTITY_HREF = "/schemas/payments/checkout/ordercancelled";

function pageData(over: Partial<EventPageData> = {}): EventPageData {
  return {
    event: makeEvent(), productId: "p1", domainSlug: "payments", productSlug: "checkout", entityOptions: ENTITY_OPTIONS, libraryTraits: [],
    crumbs: [{ label: "Domains", href: "/schemas" }, { label: "Events", href: LIST_HREF }, { label: "orders" }],
    listHref: LIST_HREF, initialTab: "design", initialSection: "metadata", initialItem: null, initialVersion: null, ...over,
  };
}
const renderPage = (over: Partial<EventPageData> = {}) => render(<EventPage data={pageData(over)} />);

const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const button = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const editTitle = () => type(field("metadata-title"), "Orders v2");
const dialog = () => screen.queryByTestId("unsaved-changes-dialog");
const eventsCrumb = () => screen.getByRole("link", { name: "Events" });

/** `prevented` is read after the guard's capture listener ran and before this swallows jsdom's "navigation not implemented". */
function click(el: Element) {
  let prevented = false;
  const probe = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
  document.addEventListener("click", probe);
  fireEvent.click(el);
  document.removeEventListener("click", probe);
  return { prevented };
}

class FakeNavigation extends EventTarget { currentEntry = { index: 4 }; }
function navigate(nav: FakeNavigation, to: string, type: "push" | "replace" | "traverse" = "push", index = -1): Event {
  const event = new Event("navigate", { cancelable: true });
  Object.assign(event, { navigationType: type, hashChange: false, downloadRequest: null, destination: { url: new URL(to, window.location.href).href, sameDocument: false, index } });
  act(() => { nav.dispatchEvent(event); });
  return event;
}

const REJECTED = {
  success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
  suggestedFix: "Fix the highlighted fields and save again.", details: { problems: [{ pointer: "/info/title", message: "title is required" }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "navigation");
  h.update.mockResolvedValue({ success: true, data: makeEvent() });
  h.rename.mockResolvedValue({ success: true, data: makeEvent() });
  h.remove.mockResolvedValue({ success: true, data: { id: "ev1" } });
  h.preview.mockResolvedValue({ success: true, data: { document: null, json: null, yaml: null, diagnostics: [] } });
  h.previewPublish.mockResolvedValue({ success: true, data: { isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0", reasons: [], blockers: [] } });
  h.listVersions.mockResolvedValue({ success: true, data: [] });
  h.listUsages.mockResolvedValue({ success: true, data: { rows: [], truncated: false } });
  window.history.replaceState(null, "", EVENT_URL);
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "navigation");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EventPage leave guard: a clean draft", () => {
  it("never asks: a link click is left to the router", () => {
    renderPage();
    expect(click(eventsCrumb()).prevented).toBe(false);
    expect(dialog()).toBeNull();
    expect(canNavigate("/schemas/payments")).toBe(true);
  });

  it("is clean again after a save, and stops asking", async () => {
    renderPage();
    editTitle();
    expect(click(eventsCrumb()).prevented).toBe(true);
    fireEvent.click(screen.getByTestId("leave-stay"));
    fireEvent.click(button("builder-save"));
    await waitFor(() => expect(button("builder-save").disabled).toBe(true));
    expect(click(eventsCrumb()).prevented).toBe(false);
  });
});

describe("EventPage leave guard: a dirty draft and a link click", () => {
  it("asks instead of navigating, and Stay keeps the page and the edit", () => {
    renderPage();
    editTitle();
    expect(click(eventsCrumb()).prevented).toBe(true);
    expect(dialog()).not.toBeNull();
    expect(h.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("leave-stay"));
    expect(dialog()).toBeNull();
    expect(field("metadata-title").value).toBe("Orders v2");
    expect(h.push).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("Escape stays too", () => {
    renderPage();
    editTitle();
    click(eventsCrumb());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(field("metadata-title").value).toBe("Orders v2");
  });

  it("Save & leave saves the draft, then goes to the link", async () => {
    renderPage();
    editTitle();
    click(eventsCrumb());
    fireEvent.click(screen.getByTestId("leave-save"));
    await waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
    expect(h.push).toHaveBeenCalledWith(LIST_HREF);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect((h.update.mock.calls[0][2] as { info: { title: string } }).info.title).toBe("Orders v2");
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.push.mock.invocationCallOrder[0]);
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("a save the server refuses keeps the user on the page, the dialog open and the error visible", async () => {
    h.update.mockResolvedValue(REJECTED);
    renderPage();
    editTitle();
    click(eventsCrumb());
    fireEvent.click(screen.getByTestId("leave-save"));
    const error = await screen.findByTestId("unsaved-changes-error");
    expect(error.textContent).toContain("1 problem(s) in the event document");
    expect(dialog()).not.toBeNull();
    expect(h.push).not.toHaveBeenCalled();
    expect(field("metadata-title").value).toBe("Orders v2"); // every edit is kept

    // and Stay closes it, the page still dirty and still guarded
    fireEvent.click(screen.getByTestId("leave-stay"));
    expect(dialog()).toBeNull();
    expect(click(eventsCrumb()).prevented).toBe(true);
  });

  it("a save that throws shows the generic message, never the cause, and stays", async () => {
    h.update.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    renderPage();
    editTitle();
    click(eventsCrumb());
    fireEvent.click(screen.getByTestId("leave-save"));
    const error = await screen.findByTestId("unsaved-changes-error");
    expect(error.textContent).toBe(GENERIC_ACTION_ERROR);
    expect(error.textContent).not.toContain("ECONNREFUSED");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("after a refused save the user can try again, and a save that works then leaves", async () => {
    h.update.mockResolvedValueOnce(REJECTED);
    renderPage();
    editTitle();
    click(eventsCrumb());
    fireEvent.click(screen.getByTestId("leave-save"));
    await screen.findByTestId("unsaved-changes-error");
    fireEvent.click(screen.getByTestId("leave-save"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(LIST_HREF));
    expect(h.update).toHaveBeenCalledTimes(2);
  });

  it("Discard & leave drops the edit without saving, then goes to the link", async () => {
    renderPage();
    editTitle();
    click(eventsCrumb());
    fireEvent.click(screen.getByTestId("leave-discard"));
    await waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
    expect(h.push).toHaveBeenCalledWith(LIST_HREF);
    expect(h.update).not.toHaveBeenCalled();
    expect(field("metadata-title").value).toBe("Orders"); // the page stayed mounted in this test: the draft is the saved one again
    expect(button("builder-save").disabled).toBe(true);
    expect(dialog()).toBeNull();
  });

  it("the entity link in a pinned-headers note is a plain same-tab link: one click asks", () => {
    const doc = {
      ...sampleDocument(),
      traits: [{ key: "idem", kind: "MESSAGE" as const, spec: { name: "Idempotent" }, headers: { entityId: "ent-2", entityVersionId: "ver-2" } }],
    };
    renderPage({ event: makeEvent(doc), initialSection: "traits", initialItem: "idem" });
    const link = screen.getByRole("link", { name: "OrderCancelled" });
    expect(link.getAttribute("href")).toBe(ENTITY_HREF);
    expect(click(link).prevented).toBe(false); // clean draft: it goes straight through

    type(screen.getByTestId("trait-name"), "Idempotent v2");
    expect(button("builder-save").disabled).toBe(false); // the edit made the draft dirty
    expect(click(screen.getByRole("link", { name: "OrderCancelled" })).prevented).toBe(true);
    expect(dialog()).not.toBeNull();
    expect(h.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("leave-discard"));
    expect(h.push).toHaveBeenCalledWith(ENTITY_HREF);
  });
});

describe("EventPage leave guard: what never asks", () => {
  it("switching tabs, sections and items inside the page, which rewrite the URL, never asks", () => {
    renderPage();
    editTitle();
    fireEvent.click(screen.getByRole("tab", { name: "Docs" }));
    expect(window.location.search).toBe("?tab=docs");
    fireEvent.click(screen.getByRole("tab", { name: "Design" }));
    fireEvent.click(screen.getByTestId("outline-servers"));
    expect(window.location.search).toBe("?section=servers");
    fireEvent.click(screen.getByTestId("outline-metadata"));
    expect(dialog()).toBeNull();
    expect(h.push).not.toHaveBeenCalled();
    expect(field("metadata-title").value).toBe("Orders v2"); // and the edit survived all of it
  });

  it("a link that stays on this page (another query, a hash) never asks", () => {
    renderPage();
    editTitle();
    const same = document.createElement("a");
    same.setAttribute("href", `${EVENT_URL}?tab=versions`);
    document.body.append(same);
    expect(click(same).prevented).toBe(false);
    same.setAttribute("href", "#servers");
    expect(click(same).prevented).toBe(false);
    same.remove();
    expect(dialog()).toBeNull();
  });
});

describe("EventPage leave guard: delete", () => {
  it("a deleted event is left without a question, even with unsaved edits", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    editTitle();
    fireEvent.click(button("event-delete"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(LIST_HREF));
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    // the guard is off: the shell's own navigation, a link click, nothing is held back any more
    expect(canNavigate("/schemas/payments")).toBe(true);
    expect(click(eventsCrumb()).prevented).toBe(false);
  });

  it("a delete that fails keeps the guard", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    h.remove.mockResolvedValue({ success: false, error: 'Event "orders" is referenced by payments/checkout.', code: "IN_USE" });
    renderPage();
    editTitle();
    fireEvent.click(button("event-delete"));
    await screen.findByTestId("event-delete-error");
    expect(click(eventsCrumb()).prevented).toBe(true);
    expect(dialog()).not.toBeNull();
  });
});

describe("EventPage leave guard: the shell's own navigation and Back", () => {
  it("the explorer's navigation is held back while dirty, and asked about", () => {
    renderPage();
    expect(canNavigate("/schemas/payments/checkout")).toBe(true); // clean
    editTitle();
    let allowed = true;
    act(() => { allowed = canNavigate("/schemas/payments/checkout"); });
    expect(allowed).toBe(false);
    expect(dialog()).not.toBeNull();
    fireEvent.click(screen.getByTestId("leave-discard"));
    expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout");
  });

  it("Back (popstate, no Navigation API) asks, and Discard & leave goes back past the page", () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    renderPage();
    editTitle();
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(dialog()).not.toBeNull();
    fireEvent.click(screen.getByTestId("leave-discard"));
    expect(go).toHaveBeenCalledWith(-2);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("with the Navigation API: a cancelable navigate asks, a replace (the page's own URL rewrite) does not", () => {
    const nav = new FakeNavigation();
    Object.defineProperty(window, "navigation", { configurable: true, value: nav });
    renderPage();
    editTitle();
    expect(navigate(nav, `${EVENT_URL}?tab=docs`, "replace").defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();
    expect(navigate(nav, "/schemas/payments").defaultPrevented).toBe(true);
    expect(dialog()).not.toBeNull();
    fireEvent.click(screen.getByTestId("leave-save"));
    return waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments"));
  });
});
