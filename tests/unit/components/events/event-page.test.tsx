// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  refresh: vi.fn(), push: vi.fn(), invalidate: vi.fn(), toastSuccess: vi.fn(),
  update: vi.fn(), rename: vi.fn(), remove: vi.fn(), preview: vi.fn(),
}));
vi.mock("next/navigation", () => {
  const router = { refresh: h.refresh, push: h.push };
  return { useRouter: () => router };
});
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: vi.fn() } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => h.invalidate }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  updateEventDocumentAction: h.update, renameEventAction: h.rename, deleteEventAction: h.remove, previewEventDocumentAction: h.preview,
  // The Publish / Versions / Used by flows have their own file (event-page-publish.test.tsx).
  previewEventPublishAction: vi.fn(), publishEventAction: vi.fn(), listEventVersionsAction: vi.fn(), readEventVersionAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: vi.fn() }));
// The real component renders a sandboxed iframe (covered by asyncapi-preview.test.tsx).
vi.mock("@/features/events/event-specs/AsyncApiPreview", () => ({
  AsyncApiPreview: (p: { document: unknown; title: string }) => <div data-testid="asyncapi-preview" data-title={p.title}>{JSON.stringify(p.document)}</div>,
}));

import { RightPanel } from "@/components/layout/RightPanel";
import { RightPanelContentProvider, useRightPanelContent } from "@/hooks/useRightPanelContent";
import { EventPage } from "@/features/events/event-page/EventPage";
import type { EventPageData } from "@/features/events/event-page/load-event-page";
import { assetHref, normalizeEventTab } from "@/lib/navigation/asset-href";
import { emptyEventDocument } from "@/lib/events/document/types";
import { ENTITY_OPTIONS, makeEvent } from "./builder-harness";

// The "+ Add" chooser is a cmdk list inside a popover: it measures and scrolls, jsdom does neither.
globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;

const LIST_HREF = assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" });
const EVENT_URL = assetHref({ kind: "event", id: "ev1", domainSlug: "payments", productSlug: "checkout" });
const EMISSION = {
  document: { asyncapi: "3.0.0", info: { title: "Orders", version: "draft" } }, json: "{}", yaml: "asyncapi: 3.0.0\n",
  diagnostics: [{ severity: "warning" as const, code: "UNPUBLISHED_PIN", message: "Payload is not pinned to a published version.", pointer: "/messages/0/payload" }],
};

const LIBRARY_TRAITS: EventPageData["libraryTraits"] = [
  { id: "lib-msg", name: "Audit headers", kind: "MESSAGE", level: "Enterprise" },
  { id: "lib-op", name: "Retry policy", kind: "OPERATION", level: "Domain · Payments" },
];

function pageData(over: Partial<EventPageData> = {}): EventPageData {
  return {
    event: makeEvent(), productId: "p1", domainSlug: "payments", productSlug: "checkout", entityOptions: ENTITY_OPTIONS, libraryTraits: LIBRARY_TRAITS,
    crumbs: [{ label: "Domains", href: "/schemas" }, { label: "Payments", href: "/schemas/payments" }, { label: "Events", href: LIST_HREF }, { label: "orders" }],
    listHref: LIST_HREF, initialTab: "design", initialSection: "metadata", initialItem: null, initialVersion: null, ...over,
  };
}
const renderPage = (over: Partial<EventPageData> = {}) => render(<EventPage data={pageData(over)} />);

const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const button = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;
/** Delete lives in the "More actions" menu: open it, then choose Delete. */
const deleteEvent = () => {
  fireEvent.click(screen.getByTestId("event-actions"));
  fireEvent.click(screen.getByTestId("event-delete"));
};
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const openTab = (name: "Design" | "Docs") => fireEvent.click(screen.getByRole("tab", { name }));
const isHidden = (testId: string) => screen.getByTestId(testId).hasAttribute("hidden");
const search = () => window.location.search;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.update.mockResolvedValue({ success: true, data: makeEvent() });
  h.rename.mockResolvedValue({ success: true, data: { ...makeEvent(), name: "payments-events" } });
  h.remove.mockResolvedValue({ success: true, data: { id: "ev1" } });
  h.preview.mockResolvedValue({ success: true, data: EMISSION });
  window.history.replaceState(null, "", EVENT_URL);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EventPage: Mod+S", () => {
  it("saves while the Design tab shows, and not while another tab does", async () => {
    renderPage();
    type(field("metadata-title"), "Edited title");
    openTab("Docs");
    await act(async () => { fireEvent.keyDown(document, { key: "s", metaKey: true }); });
    expect(h.update).not.toHaveBeenCalled();
    openTab("Design");
    await act(async () => { fireEvent.keyDown(document, { key: "s", metaKey: true }); });
    expect(h.update).toHaveBeenCalledTimes(1);
  });
});

describe("EventPage: header", () => {
  it("shows the event name as the page heading, with the breadcrumb", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("orders");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toContain("Payments");
    expect(crumbs.textContent).toContain("Events");
    expect(screen.getByRole("link", { name: "Events" }).getAttribute("href")).toBe(LIST_HREF);
  });

  it("shows the spec, version and Draft badges of a never-published event", () => {
    renderPage();
    expect(screen.getByTestId("event-spec-badge").textContent).toBe("AsyncAPI 3.0");
    expect(screen.getByTestId("event-version-badge").textContent).toBe("Unpublished");
    expect(screen.getByTestId("event-draft-badge").textContent).toBe("Draft");
  });

  it("shows the latest version, and no Draft badge when nothing changed since it was published", () => {
    renderPage({ event: { ...makeEvent(), latestVersionLabel: "1.2", hasUnpublishedChanges: false } });
    expect(screen.getByTestId("event-version-badge").textContent).toBe("v1.2");
    expect(screen.queryByTestId("event-draft-badge")).toBeNull();
  });

  it("falls back to the raw spec type for a format it has no label for", () => {
    renderPage({ event: { ...makeEvent(), specType: "openapi@3.1" } });
    expect(screen.getByTestId("event-spec-badge").textContent).toBe("openapi@3.1");
  });

  it("has the Design, Docs, Versions and Used by tabs", () => {
    renderPage();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Design", "Docs", "Versions", "Used by"]);
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("orders sections");
  });

  it("does not show another event's edits when the page is reused for a different event", () => {
    const { rerender } = renderPage();
    type(field("metadata-title"), "Edited title");
    expect(button("builder-save").disabled).toBe(false);
    rerender(<EventPage data={pageData({ event: makeEvent(emptyEventDocument("Other title", ""), "ev2") })} />);
    expect(field("metadata-title").value).toBe("Other title");
    expect(button("builder-save").disabled).toBe(true);
  });
});

describe("EventPage: tabs", () => {
  it("opens on Design by default, with the builder visible and the Docs panel empty", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "Design" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Docs" }).getAttribute("aria-selected")).toBe("false");
    expect(isHidden("event-panel-design")).toBe(false);
    expect(isHidden("event-panel-docs")).toBe(true);
    expect(screen.getByTestId("event-builder")).toBeDefined();
    expect(screen.queryByTestId("event-preview")).toBeNull();
  });

  it("opens on Docs when the page was loaded with ?tab=docs, builder still mounted behind it", () => {
    renderPage({ initialTab: "docs" });
    expect(screen.getByRole("tab", { name: "Docs" }).getAttribute("aria-selected")).toBe("true");
    expect(isHidden("event-panel-design")).toBe(true);
    expect(isHidden("event-panel-docs")).toBe(false);
    expect(screen.getByTestId("metadata-title")).toBeDefined();
    expect(screen.getByTestId("event-preview")).toBeDefined();
  });

  it("lands on Design for the old ?tab=editor alias (normalized by normalizeEventTab) and writes the clean URL", () => {
    window.history.replaceState(null, "", `${EVENT_URL}?tab=editor`);
    renderPage({ initialTab: normalizeEventTab("editor") });
    expect(screen.getByRole("tab", { name: "Design" }).getAttribute("aria-selected")).toBe("true");
    expect(isHidden("event-panel-design")).toBe(false);
    expect(search()).toBe("");
  });

  it("lands on Docs for the old ?tab=document and ?tab=diagnostics aliases", () => {
    for (const alias of ["document", "diagnostics"]) {
      window.history.replaceState(null, "", `${EVENT_URL}?tab=${alias}`);
      const { unmount } = renderPage({ initialTab: normalizeEventTab(alias) });
      expect(screen.getByRole("tab", { name: "Docs" }).getAttribute("aria-selected")).toBe("true");
      expect(search()).toBe("?tab=docs");
      unmount();
    }
  });

  it("keeps ?tab=preview (the slice-1 name of the Docs tab) working: it opens Docs and the URL is rewritten to ?tab=docs", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", `${EVENT_URL}?tab=preview`);
    renderPage({ initialTab: normalizeEventTab("preview") });
    expect(screen.getByRole("tab", { name: "Docs" }).getAttribute("aria-selected")).toBe("true");
    expect(isHidden("event-panel-docs")).toBe(false);
    expect(screen.getByTestId("event-preview")).toBeDefined();
    expect(search()).toBe("?tab=docs");
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByTestId("asyncapi-preview")).toBeDefined();
  });

  it("has no tab called Preview any more", () => {
    renderPage();
    expect(screen.queryByRole("tab", { name: "Preview" })).toBeNull();
    expect(screen.queryByTestId("event-tab-preview")).toBeNull();
    expect(screen.getByTestId("event-tab-docs").textContent).toBe("Docs");
  });

  it("keeps the builder MOUNTED while Docs shows: an edit made in Design survives a round trip (same DOM node, still dirty)", () => {
    renderPage();
    const title = field("metadata-title");
    type(title, "Orders v2");
    expect(button("builder-save").disabled).toBe(false);

    openTab("Docs");
    expect(isHidden("event-panel-design")).toBe(true);
    expect(screen.getByTestId("metadata-title")).toBe(title);
    expect((screen.getByTestId("metadata-title") as HTMLInputElement).value).toBe("Orders v2");

    openTab("Design");
    expect(isHidden("event-panel-design")).toBe(false);
    expect(screen.getByTestId("metadata-title")).toBe(title);
    expect(field("metadata-title").value).toBe("Orders v2");
    expect(button("builder-save").disabled).toBe(false);
    expect(screen.getByTestId("builder-status").textContent).toBe("Unsaved changes");
  });

  it("keeps the selected section and its edits across tabs too", () => {
    renderPage();
    fireEvent.click(button("outline-servers"));
    fireEvent.click(screen.getByTestId("server-add"));
    const host = field("server-host");
    type(host, "broker.internal:9092");
    openTab("Docs");
    openTab("Design");
    expect(screen.getByTestId("server-host")).toBe(host);
    expect(field("server-host").value).toBe("broker.internal:9092");
  });

  it("moves between tabs with ArrowRight / ArrowLeft / Home / End (roving tabindex)", () => {
    renderPage();
    const design = screen.getByRole("tab", { name: "Design" });
    const docs = screen.getByRole("tab", { name: "Docs" });
    expect(design.getAttribute("tabindex")).toBe("0");
    expect(docs.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(design, { key: "ArrowRight" });
    expect(docs.getAttribute("aria-selected")).toBe("true");
    expect(docs.getAttribute("tabindex")).toBe("0");
    expect(design.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(docs);

    // The four tabs cycle in full (see event-page-publish.test.tsx); from the last one the arrow wraps to Design.
    fireEvent.keyDown(docs, { key: "Home" });
    expect(design.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(design, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Used by" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Used by" }), { key: "ArrowRight" });
    expect(design.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(design, { key: "End" });
    expect(screen.getByRole("tab", { name: "Used by" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Used by" }), { key: "a" });
    expect(screen.getByRole("tab", { name: "Used by" }).getAttribute("aria-selected")).toBe("true");
  });

  it("links every tab to its panel", () => {
    renderPage();
    for (const [name, panel] of [["Design", "event-panel-design"], ["Docs", "event-panel-docs"], ["Versions", "event-panel-versions"], ["Used by", "event-panel-used-by"]] as const) {
      const tab = screen.getByRole("tab", { name });
      const el = screen.getByTestId(panel);
      expect(tab.getAttribute("aria-controls")).toBe(el.id);
      expect(el.getAttribute("role")).toBe("tabpanel");
      expect(el.getAttribute("aria-labelledby")).toBe(tab.id);
    }
  });
});

describe("EventPage: URL sync", () => {
  it("writes ?tab= when the tab changes (and drops it again for the default tab)", () => {
    renderPage();
    openTab("Docs");
    expect(search()).toBe("?tab=docs");
    openTab("Design");
    expect(search()).toBe("");
  });

  it("writes ?section= and ?item= as the user moves through the builder, and clears the item on a section switch", () => {
    renderPage();
    fireEvent.click(button("outline-servers"));
    expect(search()).toBe("?section=servers");
    fireEvent.click(screen.getByTestId("server-row-kafka-dev"));
    expect(search()).toBe("?section=servers&item=kafka-dev");
    fireEvent.click(button("outline-metadata"));
    expect(search()).toBe("");
  });

  it("keeps the section and item in the URL when the tab changes, in tab / section / item order", () => {
    renderPage();
    fireEvent.click(button("outline-servers"));
    fireEvent.click(screen.getByTestId("server-row-kafka-dev"));
    openTab("Docs");
    expect(search()).toBe("?tab=docs&section=servers&item=kafka-dev");
    openTab("Design");
    expect(search()).toBe("?section=servers&item=kafka-dev");
  });

  it("starts on the section and item named by the page data (deep link)", () => {
    window.history.replaceState(null, "", `${EVENT_URL}?section=servers&item=kafka-dev`);
    renderPage({ initialSection: "servers", initialItem: "kafka-dev" });
    expect(button("outline-servers").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("server-row-kafka-dev").getAttribute("aria-current")).toBe("true");
    expect(field("server-host").value).toBe("dev.internal:9092");
    expect(search()).toBe("?section=servers&item=kafka-dev");
  });

  it("uses the History API, never a router navigation (no server round trip to switch a tab)", () => {
    const replace = vi.spyOn(window.history, "replaceState");
    renderPage();
    openTab("Docs");
    expect(replace).toHaveBeenCalledWith(null, "", `${EVENT_URL}?tab=docs`);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("writes ?section=traits and ?section=advanced, and opens on them from a deep link", () => {
    renderPage();
    fireEvent.click(button("outline-traits"));
    expect(search()).toBe("?section=traits");
    fireEvent.click(button("outline-advanced"));
    expect(search()).toBe("?section=advanced");
    cleanup();
    window.history.replaceState(null, "", `${EVENT_URL}?section=advanced`);
    renderPage({ initialSection: "advanced" });
    expect(button("outline-advanced").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("section-advanced")).toBeDefined();
  });
});

describe("EventPage: library message properties", () => {
  const openChooser = async () => {
    fireEvent.click(button("trait-add"));
    return screen.findByTestId("trait-chooser");
  };

  it("hands the library traits of the page data to the builder: the + Add chooser offers them by kind", async () => {
    renderPage({ initialSection: "traits" });
    await openChooser();
    expect(within(screen.getByTestId("trait-chooser-group-library")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Audit headersEnterprise"]);
    fireEvent.click(screen.getByTestId("trait-chooser-kind-operation"));
    expect(within(screen.getByTestId("trait-chooser-group-library")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Retry policyDomain · Payments"]);
  });

  it("adds a library set from the page and saves a document that names it by its library id", async () => {
    renderPage({ initialSection: "traits" });
    await openChooser();
    fireEvent.click(screen.getByTestId("trait-chooser-item-lib-msg"));
    fireEvent.click(button("builder-save"));
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
    expect(h.update.mock.calls[0][2]).toMatchObject({ traits: [{ key: "Audit-headers", kind: "MESSAGE", libraryTraitId: "lib-msg" }] });
  });

  it("offers only the blank set for a page loaded without library traits", async () => {
    renderPage({ initialSection: "traits", libraryTraits: [] });
    await openChooser();
    expect(screen.queryByTestId("trait-chooser-group-library")).toBeNull();
    expect(screen.queryByTestId("trait-chooser-group-builtin")).toBeNull();
    expect(screen.getByTestId("trait-chooser-item-new")).toBeDefined();
  });
});

describe("EventPage: Save", () => {
  it("saves the draft through updateEventDocumentAction, toasts, and refreshes the server data", async () => {
    renderPage();
    type(field("metadata-title"), "Orders v2");
    fireEvent.click(button("builder-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.update).toHaveBeenCalledTimes(1);
    const [eventId, productId, document] = h.update.mock.calls[0];
    expect([eventId, productId]).toEqual(["ev1", "p1"]);
    expect(document.info.title).toBe("Orders v2");
    expect(h.toastSuccess).toHaveBeenCalledWith("Draft saved");
    expect(screen.getByTestId("builder-status").textContent).toBe("No unsaved changes");
  });

  it("keeps every edit, shows the error and neither toasts nor refreshes when the save fails", async () => {
    h.update.mockResolvedValue({ success: false, error: "The document is not valid", code: "VALIDATION_ERROR", details: { problems: [{ pointer: "/info/title", message: "Title is required" }] } });
    renderPage();
    type(field("metadata-title"), "Orders v2");
    fireEvent.click(button("builder-save"));
    expect((await screen.findByTestId("builder-error")).textContent).toContain("The document is not valid");
    expect(field("metadata-title").value).toBe("Orders v2");
    expect(button("builder-save").disabled).toBe(false);
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe("EventPage: Docs", () => {
  beforeEach(() => vi.useFakeTimers());
  const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("calls the preview action ONCE after the 600 ms debounce, with the UNSAVED document, and renders the result", async () => {
    renderPage();
    type(field("metadata-title"), "Orders v2");
    openTab("Docs");
    expect(h.preview).not.toHaveBeenCalled();
    expect(screen.getByTestId("preview-status").textContent).toContain("Rendering");

    await flush(599);
    expect(h.preview).not.toHaveBeenCalled();
    await flush(1);
    expect(h.preview).toHaveBeenCalledTimes(1);
    const [eventId, productId, document] = h.preview.mock.calls[0];
    expect([eventId, productId]).toEqual(["ev1", "p1"]);
    expect(document.info.title).toBe("Orders v2");
    expect(h.update).not.toHaveBeenCalled();

    expect(screen.getByTestId("asyncapi-preview").textContent).toBe(JSON.stringify(EMISSION.document));
    expect(screen.getByTestId("asyncapi-preview").getAttribute("data-title")).toBe("orders");
    expect(screen.getByTestId("preview-status").textContent).toBe("");
    await flush(5000);
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it("lists the diagnostics of the emission under the preview", async () => {
    renderPage();
    openTab("Docs");
    await flush(600);
    const list = screen.getByTestId("diagnostics-list");
    expect(list.textContent).toContain("Payload is not pinned to a published version.");
    expect(list.textContent).toContain("/messages/0/payload");
    expect(list.textContent).toContain("0 errors · 1 warning");
  });

  it("shows 'No problems found' for an emission without diagnostics", async () => {
    h.preview.mockResolvedValue({ success: true, data: { ...EMISSION, diagnostics: [] } });
    renderPage();
    openTab("Docs");
    await flush(600);
    expect(screen.getByTestId("diagnostics-list").textContent).toContain("No problems found");
  });

  it("does not call the action at all while the draft has client-side problems, and says to fix them first", async () => {
    renderPage();
    type(field("metadata-title"), "");
    expect(screen.getByTestId("outline-problems-metadata")).toBeDefined();
    openTab("Docs");
    await flush(5000);
    expect(h.preview).not.toHaveBeenCalled();
    expect(screen.getByTestId("preview-blocked").textContent).toContain("Fix the problems in Design first");
    expect(screen.queryByTestId("asyncapi-preview")).toBeNull();
    expect(screen.queryByTestId("diagnostics-list")).toBeNull();
    expect(screen.queryByTestId("preview-status")).toBeNull();
  });

  it("offers a way back to Design from the blocked state, and previews once the problem is fixed", async () => {
    renderPage();
    type(field("metadata-title"), "");
    openTab("Docs");
    fireEvent.click(screen.getByTestId("preview-blocked-back"));
    expect(screen.getByRole("tab", { name: "Design" }).getAttribute("aria-selected")).toBe("true");
    type(field("metadata-title"), "Fixed");
    openTab("Docs");
    await flush(600);
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview.mock.calls[0][2].info.title).toBe("Fixed");
  });

  it("does not call the action while the Design tab is showing (the builder never previews behind the user's back)", async () => {
    renderPage();
    type(field("metadata-title"), "Orders v2");
    await flush(5000);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("cancels the pending call when the user leaves Preview before the debounce elapsed", async () => {
    renderPage();
    openTab("Docs");
    await flush(300);
    openTab("Design");
    await flush(5000);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("does not re-render an unchanged document when Preview is reopened", async () => {
    renderPage();
    openTab("Docs");
    await flush(600);
    openTab("Design");
    openTab("Docs");
    await flush(5000);
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("asyncapi-preview")).toBeDefined();
  });

  it("previews again after an edit, with the new document", async () => {
    renderPage();
    openTab("Docs");
    await flush(600);
    openTab("Design");
    type(field("metadata-title"), "Orders v3");
    openTab("Docs");
    expect(screen.getByTestId("preview-status").textContent).toContain("Rendering");
    await flush(600);
    expect(h.preview).toHaveBeenCalledTimes(2);
    expect(h.preview.mock.calls[1][2].info.title).toBe("Orders v3");
  });

  it("Refresh re-renders immediately (no debounce), even for an unchanged document", async () => {
    renderPage();
    openTab("Docs");
    await flush(600);
    expect(h.preview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("preview-refresh"));
    expect(h.preview).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("preview-status").textContent).toContain("Rendering");
    await flush(0);
    expect(screen.getByTestId("preview-status").textContent).toBe("");
    expect(h.preview.mock.calls[1]).toEqual(h.preview.mock.calls[0]);
  });

  it("shows the newest answer when an older, slower one arrives last", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderPage();
    openTab("Docs");
    await flush(600);
    fireEvent.click(screen.getByTestId("preview-refresh"));
    expect(h.preview).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve({ success: true, data: { ...EMISSION, document: { asyncapi: "3.0.0", marker: "newest" } } }); });
    await act(async () => { first.resolve({ success: true, data: { ...EMISSION, document: { asyncapi: "3.0.0", marker: "stale" } } }); });
    expect(screen.getByTestId("asyncapi-preview").textContent).toContain("newest");
    expect(screen.getByTestId("asyncapi-preview").textContent).not.toContain("stale");
  });

  it("shows the diagnostics and an empty-state message (no crash, no preview frame) when the document could not be built", async () => {
    h.preview.mockResolvedValue({
      success: true,
      data: {
        document: null, json: null, yaml: null,
        diagnostics: [{ severity: "error", code: "RENDER_FAILED", message: "The payload of OrderCreated does not render.", pointer: "/messages/0/payload" }],
      },
    });
    renderPage();
    openTab("Docs");
    await flush(600);
    expect(screen.getByTestId("preview-empty").textContent).toContain("could not be built");
    expect(screen.queryByTestId("asyncapi-preview")).toBeNull();
    expect(screen.getByTestId("diagnostics-list").textContent).toContain("The payload of OrderCreated does not render.");
    expect(screen.getByTestId("diagnostics-list").textContent).toContain("1 error");
    expect(screen.queryByTestId("preview-error")).toBeNull();
  });

  it("shows the action's error text, and a Retry through Refresh", async () => {
    h.preview.mockResolvedValue({ success: false, error: 'Event "ev1" not found', code: "NOT_FOUND" });
    renderPage();
    openTab("Docs");
    await flush(600);
    expect(screen.getByTestId("preview-error").getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("preview-error").textContent).toContain('Event "ev1" not found');
    expect(screen.queryByTestId("asyncapi-preview")).toBeNull();
    await flush(5000);
    expect(h.preview).toHaveBeenCalledTimes(1);

    h.preview.mockResolvedValue({ success: true, data: EMISSION });
    fireEvent.click(screen.getByTestId("preview-refresh"));
    await flush(0);
    expect(screen.queryByTestId("preview-error")).toBeNull();
    expect(screen.getByTestId("asyncapi-preview")).toBeDefined();
  });

  it("never prints the cause of a rejected action or the raw text of a database error", async () => {
    h.preview.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    renderPage();
    openTab("Docs");
    await flush(600);
    expect(screen.getByTestId("preview-error").textContent).toContain("Something went wrong");
    expect(screen.getByTestId("preview-error").textContent).not.toContain("ECONNREFUSED");

    h.preview.mockResolvedValue({ success: false, error: 'relation "event_specs" does not exist', code: "DB_ERROR" });
    fireEvent.click(screen.getByTestId("preview-refresh"));
    await flush(0);
    expect(screen.getByTestId("preview-error").textContent).toContain("Something went wrong");
    expect(screen.getByTestId("preview-error").textContent).not.toContain("event_specs");
  });

  it("says the preview shows unsaved changes only when there are some", async () => {
    renderPage();
    openTab("Docs");
    await flush(600);
    expect(screen.queryByTestId("preview-unsaved-note")).toBeNull();
    openTab("Design");
    type(field("metadata-title"), "Orders v2");
    openTab("Docs");
    expect(screen.getByTestId("preview-unsaved-note").textContent).toContain("unsaved changes");
    await flush(600);
  });

  it("previews as soon as the page opens on Preview (?tab=docs), after the debounce", async () => {
    renderPage({ initialTab: "docs" });
    expect(h.preview).not.toHaveBeenCalled();
    await flush(600);
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("asyncapi-preview")).toBeDefined();
  });
});

describe("EventPage: live code in the shell's right Detail Panel", () => {
  beforeEach(() => vi.useFakeTimers());
  const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const noop = () => {};

  /** Mirrors DashboardShell: the right panel shows whatever the page pushed, is collapsible, and reports its state to the context. */
  function Shell({ children, contents }: { children?: ReactNode; contents?: unknown[] }) {
    const { content, registerExpandHandler, registerCollapseHandler, registerToggleHandler, registerCollapsedState } = useRightPanelContent();
    const [collapsed, setCollapsed] = useState(false);
    contents?.push(content);
    useEffect(() => { registerExpandHandler(() => setCollapsed(false)); }, [registerExpandHandler]);
    useEffect(() => { registerCollapseHandler(() => setCollapsed(true)); }, [registerCollapseHandler]);
    useEffect(() => { registerToggleHandler(() => setCollapsed((c) => !c)); }, [registerToggleHandler]);
    useEffect(() => { registerCollapsedState(collapsed); }, [registerCollapsedState, collapsed]);
    return (
      <>
        <main data-testid="center-panel">{children}</main>
        <RightPanel width={400} isCollapsed={collapsed} onMouseDown={noop} onDoubleClick={noop} onCollapse={() => setCollapsed(true)}>{content}</RightPanel>
      </>
    );
  }
  const shell = (page: ReactNode, contents?: unknown[]) => (
    <RightPanelContentProvider><Shell contents={contents}>{page}</Shell></RightPanelContentProvider>
  );
  const renderInShell = (over: Partial<EventPageData> = {}, contents?: unknown[]) => render(shell(<EventPage data={pageData(over)} />, contents));
  const panel = () => within(screen.getByTestId("right-panel"));
  // The code is shown in a read-only JsonEditor; in jsdom (no CodeMirror stand-ins here) that is its textarea.
  const code = () => (panel().getByTestId("event-code-text") as HTMLTextAreaElement).value;

  it("puts the Code panel in the right Detail Panel (not in the page) instead of hiding the panel", () => {
    renderInShell();
    expect(screen.getByTestId("right-panel").getAttribute("data-collapsed")).toBe("false");
    expect(panel().getByTestId("event-code-panel")).toBeDefined();
    expect(within(screen.getByTestId("center-panel")).queryByTestId("event-code-panel")).toBeNull();
    expect(screen.queryByText("Detail Panel")).toBeNull();
  });

  it("shows the instant AsyncAPI code of the document, with the pinned entity named by its placeholder", () => {
    renderInShell();
    expect(code()).toContain("asyncapi: 3.0.0");
    expect(code()).toContain("title: Orders");
    expect(code()).toContain("x-super-schema-entity: OrderCreated@1.0");
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("shows the UNSAVED draft: an edit in Metadata is in the code at once, without saving", () => {
    renderInShell();
    type(field("metadata-title"), "Orders v2");
    expect(code()).toContain("title: Orders v2");
    expect(button("builder-save").disabled).toBe(false);
    expect(h.update).not.toHaveBeenCalled();
    type(field("metadata-title"), "Orders v3");
    expect(code()).toContain("title: Orders v3");
    expect(code()).not.toContain("title: Orders v2");
  });

  it("follows edits made in other sections too (a new server appears in the code)", () => {
    renderInShell();
    fireEvent.click(button("outline-servers"));
    fireEvent.click(screen.getByTestId("server-add"));
    type(field("server-host"), "broker.internal:9092");
    expect(code()).toContain("host: broker.internal:9092");
  });

  it("pushes the panel into the shell ONCE: edits update the panel through the draft store, not by re-pushing content", () => {
    const contents: unknown[] = [];
    renderInShell({}, contents);
    type(field("metadata-title"), "A");
    type(field("metadata-title"), "AB");
    type(field("metadata-title"), "ABC");
    expect(code()).toContain("title: ABC");
    expect(new Set(contents.filter((c) => c !== null)).size).toBe(1);
  });

  it("asks the server for the full render of the unsaved document after 800 ms, and shows it", async () => {
    renderInShell();
    type(field("metadata-title"), "Orders v2");
    await flush(799);
    expect(h.preview).not.toHaveBeenCalled();
    await flush(1);
    expect(h.preview).toHaveBeenCalledTimes(1);
    const [eventId, productId, document] = h.preview.mock.calls[0];
    expect([eventId, productId]).toEqual(["ev1", "p1"]);
    expect(document.info.title).toBe("Orders v2");
    expect(panel().getByTestId("code-status").getAttribute("data-state")).toBe("full");
    expect(code()).toBe(EMISSION.yaml);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("falls back to the instant code of the new draft the moment the draft changes after a full render", async () => {
    renderInShell();
    await flush(800);
    expect(code()).toBe(EMISSION.yaml);
    type(field("metadata-title"), "Orders v2");
    expect(panel().getByTestId("code-status").getAttribute("data-state")).toBe("rendering");
    expect(code()).toContain("title: Orders v2");
  });

  it("is still there on the Docs tab, with the same unsaved document", async () => {
    renderInShell();
    type(field("metadata-title"), "Orders v2");
    openTab("Docs");
    expect(panel().getByTestId("event-code-panel")).toBeDefined();
    expect(code()).toContain("title: Orders v2");
    await flush(1000);
    expect(h.preview.mock.calls.length).toBeGreaterThan(0);
    for (const call of h.preview.mock.calls) expect(call[2].info.title).toBe("Orders v2");
  });

  it("shows the draft's problems instead of code, and sends nothing, while the draft does not parse", async () => {
    renderInShell();
    type(field("metadata-title"), "");
    expect(panel().getByTestId("code-empty").textContent).toContain("Fix the problems in Design");
    expect(panel().getByTestId("diagnostics-list").textContent).toContain("/info/title");
    await flush(5000);
    expect(h.preview).not.toHaveBeenCalled();
    type(field("metadata-title"), "Fixed");
    expect(code()).toContain("title: Fixed");
  });

  it("has a Code button that hides and shows the panel, and a hidden panel does no work at all", async () => {
    renderInShell();
    expect(button("event-code-toggle").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("event-code-toggle"));
    expect(screen.getByTestId("right-panel").getAttribute("data-collapsed")).toBe("true");
    expect(screen.queryByTestId("event-code-panel")).toBeNull();
    expect(button("event-code-toggle").getAttribute("aria-pressed")).toBe("false");

    type(field("metadata-title"), "Orders v2");
    await flush(5000);
    expect(h.preview).not.toHaveBeenCalled();

    fireEvent.click(button("event-code-toggle"));
    expect(screen.getByTestId("right-panel").getAttribute("data-collapsed")).toBe("false");
    expect(code()).toContain("title: Orders v2");
    await flush(800);
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview.mock.calls[0][2].info.title).toBe("Orders v2");
  });

  it("stops a pending server render when the panel is closed before the debounce elapsed", async () => {
    renderInShell();
    await flush(500);
    fireEvent.click(button("event-code-toggle"));
    await flush(5000);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("unmounts cleanly when the page goes away: the panel is removed from the shell and nothing is called afterwards", async () => {
    const { rerender } = renderInShell();
    type(field("metadata-title"), "Orders v2");
    rerender(shell(null));
    expect(screen.queryByTestId("event-code-panel")).toBeNull();
    expect(screen.getByText("Detail Panel")).toBeDefined();
    await flush(5000);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("shows the other event's code, from its own draft, when the page is reused for a different event", async () => {
    const { rerender } = renderInShell();
    type(field("metadata-title"), "Edited title");
    rerender(shell(<EventPage data={pageData({ event: makeEvent(emptyEventDocument("Other title", ""), "ev2") })} />));
    expect(code()).toContain("title: Other title");
    expect(code()).not.toContain("Edited title");
    await flush(800);
    expect(h.preview.mock.calls.at(-1)?.slice(0, 2)).toEqual(["ev2", "p1"]);
  });

  it("does not touch the page when there is no shell at all (no provider): the page renders and works without a panel", () => {
    renderPage();
    expect(screen.queryByTestId("event-code-panel")).toBeNull();
    type(field("metadata-title"), "Orders v2");
    expect(field("metadata-title").value).toBe("Orders v2");
  });
});

describe("EventPage: rename", () => {
  const openRename = () => {
    fireEvent.click(screen.getByTestId("event-rename"));
    return field("event-name-input");
  };

  it("renames inline: Enter saves the trimmed name, toasts, refreshes and shows the new name", async () => {
    renderPage();
    const input = openRename();
    expect(input.value).toBe("orders");
    type(input, "  payments-events  ");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.rename).toHaveBeenCalledTimes(1);
    expect(h.rename).toHaveBeenCalledWith("ev1", "p1", "payments-events");
    expect(h.toastSuccess).toHaveBeenCalledWith("Event renamed");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("payments-events");
    expect(screen.queryByTestId("event-name-input")).toBeNull();
  });

  it("saves with the Save button as well", async () => {
    renderPage();
    type(openRename(), "payments-events");
    fireEvent.click(button("event-rename-save"));
    await waitFor(() => expect(h.rename).toHaveBeenCalledWith("ev1", "p1", "payments-events"));
  });

  it("shows the service's message inline and keeps the field open with the typed name when the rename fails", async () => {
    h.rename.mockResolvedValue({ success: false, error: 'An event named "taken" already exists in this product', code: "CONFLICT" });
    renderPage();
    const input = openRename();
    type(input, "taken");
    fireEvent.keyDown(input, { key: "Enter" });
    const error = await screen.findByTestId("event-rename-error");
    expect(error.textContent).toContain('An event named "taken" already exists');
    expect(error.getAttribute("role")).toBe("alert");
    expect(field("event-name-input").value).toBe("taken");
    expect(field("event-name-input").getAttribute("aria-describedby")).toBe(error.id);
    expect(screen.getByTestId("event-name-input").getAttribute("aria-invalid")).toBe("true");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("shows a generic message for a rejected action and for a database error", async () => {
    h.rename.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    renderPage();
    const input = openRename();
    type(input, "new-name");
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByTestId("event-rename-error")).textContent).toContain("Something went wrong");

    h.rename.mockResolvedValueOnce({ success: false, error: 'relation "event_specs" does not exist', code: "DB_ERROR" });
    fireEvent.keyDown(field("event-name-input"), { key: "Enter" });
    await waitFor(() => expect(h.rename).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("event-rename-error").textContent).not.toContain("ECONNREFUSED"));
    expect(screen.getByTestId("event-rename-error").textContent).not.toContain("event_specs");
  });

  it("does not call the action for an unchanged name, and closes the field", () => {
    renderPage();
    const input = openRename();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.rename).not.toHaveBeenCalled();
    expect(screen.queryByTestId("event-name-input")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("orders");
  });

  it("refuses a blank name on the client without calling the action", () => {
    renderPage();
    const input = openRename();
    type(input, "   ");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.rename).not.toHaveBeenCalled();
    expect(screen.getByTestId("event-rename-error").textContent).toContain("A name is required");
    expect(screen.getByTestId("event-name-input")).toBeDefined();
  });

  it("Escape and Cancel put the old name back without calling the action", () => {
    renderPage();
    const input = openRename();
    type(input, "something else");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("event-name-input")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("orders");

    type(openRename(), "something else");
    fireEvent.click(button("event-rename-cancel"));
    expect(screen.queryByTestId("event-name-input")).toBeNull();
    expect(openRename().value).toBe("orders");
    expect(h.rename).not.toHaveBeenCalled();
  });

  it("is single-flight: a second Enter while the rename is running does not send it again", async () => {
    const pending = deferred<unknown>();
    h.rename.mockReturnValue(pending.promise);
    renderPage();
    const input = openRename();
    type(input, "payments-events");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.rename).toHaveBeenCalledTimes(1);
    expect(button("event-rename-save").disabled).toBe(true);
    await act(async () => { pending.resolve({ success: true, data: { ...makeEvent(), name: "payments-events" } }); });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not touch the builder's draft: a rename leaves unsaved document edits alone", async () => {
    renderPage();
    type(field("metadata-title"), "Orders v2");
    type(openRename(), "payments-events");
    fireEvent.click(button("event-rename-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(field("metadata-title").value).toBe("Orders v2");
    expect(button("builder-save").disabled).toBe(false);
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("EventPage: the more-actions menu", () => {
  it("is a button in the header, after Publish and Code, named for what it is", () => {
    renderPage();
    const trigger = button("event-actions");
    expect(trigger.getAttribute("aria-label")).toBe("More actions");
    expect(trigger.compareDocumentPosition(button("event-code-toggle")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("keeps Delete out of the header until the menu is opened", () => {
    renderPage();
    expect(screen.queryByTestId("event-delete")).toBeNull();
    fireEvent.click(button("event-actions"));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBe(screen.getByTestId("event-delete"));
  });

  it("offers only Delete, in the destructive style", () => {
    renderPage();
    fireEvent.click(button("event-actions"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Delete"]);
    expect(screen.getByTestId("event-delete").getAttribute("data-variant")).toBe("destructive");
  });

  it("closes after Delete is chosen, and does not delete before the confirmation is answered", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    deleteEvent();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(h.remove).not.toHaveBeenCalled();
  });
});

describe("EventPage: delete", () => {
  it("does nothing when the confirmation is declined", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    deleteEvent();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('"orders"');
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("after confirming: deletes, invalidates the explorer tree, then goes to the Events list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    deleteEvent();
    await waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
    expect(h.remove).toHaveBeenCalledWith("ev1", "p1");
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith(LIST_HREF);
    expect(h.invalidate.mock.invocationCallOrder[0]).toBeLessThan(h.push.mock.invocationCallOrder[0]);
  });

  it("shows an IN_USE refusal inline with its suggested fix, stays on the page and re-enables Delete", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    h.remove.mockResolvedValue({ success: false, error: 'Event "orders" is referenced by payments/checkout.', code: "IN_USE", suggestedFix: "Remove the external reference first." });
    renderPage();
    deleteEvent();
    const error = await screen.findByTestId("event-delete-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain('Event "orders" is referenced by payments/checkout.');
    expect(error.textContent).toContain("Remove the external reference first.");
    expect(h.push).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(button("event-actions").disabled).toBe(false);
  });

  it("clears an earlier delete error when the user tries again", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    h.remove.mockResolvedValueOnce({ success: false, error: "Still referenced", code: "IN_USE" });
    renderPage();
    deleteEvent();
    await screen.findByTestId("event-delete-error");
    deleteEvent();
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(LIST_HREF));
    expect(screen.queryByTestId("event-delete-error")).toBeNull();
  });

  it("shows a generic message for a rejected action and never the cause", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    h.remove.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    renderPage();
    deleteEvent();
    const error = await screen.findByTestId("event-delete-error");
    expect(error.textContent).toContain("Something went wrong");
    expect(error.textContent).not.toContain("ECONNREFUSED");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("is single-flight and disabled while the delete runs", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const pending = deferred<unknown>();
    h.remove.mockReturnValue(pending.promise);
    renderPage();
    deleteEvent();
    expect(button("event-actions").disabled).toBe(true);
    fireEvent.click(button("event-actions"));
    expect(screen.queryByTestId("event-delete")).toBeNull();
    expect(h.remove).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ success: true, data: { id: "ev1" } }); });
    expect(h.push).toHaveBeenCalledTimes(1);
  });
});
