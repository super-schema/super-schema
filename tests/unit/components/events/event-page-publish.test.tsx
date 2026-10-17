// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import type { EventPublishAnalysis } from "@/lib/events/publish-plan";
import { ENTITY_OPTIONS, makeEvent } from "./builder-harness";

// The dialog's bump control and the "+ Add" chooser measure and scroll; jsdom does neither.
globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;

const LIST_HREF = assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" });
const EVENT_URL = assetHref({ kind: "event", id: "ev1", domainSlug: "payments", productSlug: "checkout" });

function pageData(over: Partial<EventPageData> = {}): EventPageData {
  return {
    event: makeEvent(), productId: "p1", domainSlug: "payments", productSlug: "checkout", entityOptions: ENTITY_OPTIONS, libraryTraits: [],
    crumbs: [{ label: "Domains", href: "/schemas" }, { label: "Events", href: LIST_HREF }, { label: "orders" }],
    listHref: LIST_HREF, initialTab: "design", initialSection: "metadata", initialItem: null, initialVersion: null, ...over,
  };
}
const renderPage = (over: Partial<EventPageData> = {}) => render(<EventPage data={pageData(over)} />);
const published = (label: string, hasUnpublishedChanges = false) => ({ ...makeEvent(), latestVersionLabel: label, hasUnpublishedChanges });

const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const button = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const search = () => window.location.search;
const publishButton = () => button("event-publish");

const FIRST: EventPublishAnalysis = {
  isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0", reasons: [], blockers: [],
};
const REPUBLISH: EventPublishAnalysis = {
  isFirstPublish: false, latestLabel: "1.0", suggestedBump: "MINOR", candidateLabels: { MAJOR: "2.0", MINOR: "1.1" },
  initialLabel: "1.0", reasons: ['Message "refund" added'], blockers: [],
};
const BREAKING: EventPublishAnalysis = { ...REPUBLISH, suggestedBump: "MAJOR", reasons: ["payload now references OrderCancelled instead of OrderCreated"] };
const SUMMARY = { id: "v1", major: 1, minor: 1, label: "1.1", sequence: 2, changeKind: "MINOR", changeSummary: null, publishedByName: "Ada", publishedAt: "2026-10-16T10:00:00.000Z" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.update.mockResolvedValue({ success: true, data: makeEvent() });
  h.rename.mockResolvedValue({ success: true, data: makeEvent() });
  h.remove.mockResolvedValue({ success: true, data: { id: "ev1" } });
  h.preview.mockResolvedValue({ success: true, data: { document: null, json: null, yaml: null, diagnostics: [] } });
  h.previewPublish.mockResolvedValue({ success: true, data: FIRST });
  h.publish.mockResolvedValue({ success: true, data: { ...SUMMARY, label: "1.0", sequence: 1, changeKind: "INITIAL" } });
  h.listVersions.mockResolvedValue({ success: true, data: [] });
  h.readVersion.mockImplementation(async (_e: string, _p: string, label: string) => ({ success: true, data: { yaml: `info:\n  version: ${label}\n`, json: `{"info":{"version":"${label}"}}` } }));
  h.listUsages.mockResolvedValue({ success: true, data: { rows: [], truncated: false } });
  window.history.replaceState(null, "", EVENT_URL);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EventPage: the Publish button", () => {
  it("sits in the header next to Code and Delete", () => {
    renderPage();
    const header = publishButton().parentElement!;
    expect(within(header).getByTestId("event-code-toggle")).toBeDefined();
    expect(within(header).getByTestId("event-delete")).toBeDefined();
    expect(publishButton().textContent).toContain("Publish");
  });

  it("is enabled for a saved draft with no problems", () => {
    renderPage();
    expect(publishButton().disabled).toBe(false);
    expect(publishButton().getAttribute("title")).toBeNull();
  });

  it("is disabled while there are unsaved changes, says to save first, and is enabled again once saved", async () => {
    renderPage();
    type(field("metadata-title"), "Orders v2");
    expect(publishButton().disabled).toBe(true);
    expect(publishButton().getAttribute("title")).toBe("Save your changes first");
    fireEvent.click(button("builder-save"));
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(publishButton().disabled).toBe(false));
    expect(publishButton().getAttribute("title")).toBeNull();
  });

  it("is disabled while a save is in flight", async () => {
    const saving = deferred<unknown>();
    h.update.mockReturnValue(saving.promise);
    renderPage();
    type(field("metadata-title"), "Orders v2");
    fireEvent.click(button("builder-save"));
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
    expect(publishButton().disabled).toBe(true);
    expect(publishButton().getAttribute("title")).toBe("Save your changes first");
    await act(async () => { saving.resolve({ success: true, data: makeEvent() }); });
    await waitFor(() => expect(publishButton().disabled).toBe(false));
  });

  it("is disabled while the draft has problems, and says to fix them (not to save: it cannot be saved)", () => {
    renderPage();
    type(field("metadata-title"), "");
    expect(screen.getByTestId("outline-problems-metadata")).toBeDefined();
    expect(publishButton().disabled).toBe(true);
    expect(publishButton().getAttribute("title")).toBe("Fix the highlighted problems first");
    type(field("metadata-title"), "Fixed");
    expect(publishButton().getAttribute("title")).toBe("Save your changes first");
  });

  it("does nothing when pressed while disabled", () => {
    renderPage();
    type(field("metadata-title"), "Orders v2");
    fireEvent.click(publishButton());
    expect(h.previewPublish).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-publish")).toBeNull();
  });
});

describe("EventPage: the Publish dialog", () => {
  const open = async () => {
    fireEvent.click(publishButton());
    return screen.findByRole("dialog");
  };

  it("asks the server what a publish would do, for this event and product, and offers the first version", async () => {
    renderPage();
    const dialog = await open();
    await within(dialog).findByTestId("confirm-publish");
    expect(h.previewPublish).toHaveBeenCalledTimes(1);
    expect(h.previewPublish).toHaveBeenCalledWith("ev1", "p1");
    expect(within(dialog).getByRole("heading", { name: "Publish orders" })).toBeDefined();
    expect(within(dialog).getByText(/First publish of/).textContent).toContain("v1.0");
    expect(button("confirm-publish").textContent).toContain("Publish v1.0");
    expect(button("confirm-publish").disabled).toBe(false);
  });

  it("lists the blockers, once each, and cannot be confirmed", async () => {
    h.previewPublish.mockResolvedValue({
      success: true,
      data: {
        ...FIRST,
        blockers: [
          { kind: "UNPUBLISHED_PIN", message: "OrderCreated has no published version pinned", pointer: "/messages/0/payload" },
          { kind: "UNRESOLVED_REFERENCE", message: "OrderCreated has no published version pinned", pointer: "/components/messages/order-created/payload" },
          { kind: "VALIDATION_ERROR", message: "OrderCreated has no published version pinned", pointer: "/channels/orders/messages/order-created/payload" },
          { kind: "MISSING_ENTITY", message: '"ver-9" is not a published version of OrderCancelled', pointer: "/messages/1/headers" },
        ],
      },
    });
    renderPage();
    const dialog = await open();
    await within(dialog).findByText("Cannot publish yet");
    const items = within(within(dialog).getByRole("alert")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["OrderCreated has no published version pinned", '"ver-9" is not a published version of OrderCancelled']);
    // Neutral: no pointer is shown as a path in either document.
    expect(dialog.textContent).not.toContain("/messages/0/payload");
    expect(dialog.textContent).not.toContain("/components/messages");
    expect(button("confirm-publish").disabled).toBe(true);
  });

  it("shows the server's reason when the preview cannot be loaded", async () => {
    h.previewPublish.mockResolvedValue({ success: false, error: 'Event "ev1" not found', code: "NOT_FOUND" });
    renderPage();
    const dialog = await open();
    expect((await within(dialog).findByRole("alert")).textContent).toBe('Event "ev1" not found');
    expect(screen.queryByTestId("confirm-publish")).toBeNull();
  });

  it("publishes the first version with the change summary the user typed", async () => {
    renderPage();
    const dialog = await open();
    await within(dialog).findByTestId("confirm-publish");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "  First cut  " } });
    fireEvent.click(button("confirm-publish"));
    await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    expect(h.publish).toHaveBeenCalledWith("ev1", "p1", { bump: undefined, changeSummary: "First cut" });
  });

  it("publishes a republish with the suggested bump, and a raised one when the user raises it", async () => {
    h.previewPublish.mockResolvedValue({ success: true, data: REPUBLISH });
    h.publish.mockResolvedValue({ success: true, data: SUMMARY });
    renderPage({ event: published("1.0", true) });
    let dialog = await open();
    await within(dialog).findByTestId("confirm-publish");
    expect(button("confirm-publish").textContent).toContain("Publish v1.1");
    fireEvent.click(button("confirm-publish"));
    await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    expect(h.publish).toHaveBeenLastCalledWith("ev1", "p1", { bump: "MINOR", changeSummary: undefined });

    h.publish.mockResolvedValue({ success: false, error: "stop here", code: "CONFLICT" });
    dialog = await open();
    await waitFor(() => expect(button("confirm-publish").textContent).toContain("Publish v1.1"));
    fireEvent.click(button("bump-major"));
    expect(button("confirm-publish").textContent).toContain("Publish v2.0");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Breaking on purpose" } });
    fireEvent.click(button("confirm-publish"));
    await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
    expect(h.publish).toHaveBeenLastCalledWith("ev1", "p1", { bump: "MAJOR", changeSummary: "Breaking on purpose" });
  });

  it("will not let a breaking change go out as a minor", async () => {
    h.previewPublish.mockResolvedValue({ success: true, data: BREAKING });
    renderPage({ event: published("1.0", true) });
    const dialog = await open();
    await within(dialog).findByTestId("confirm-publish");
    expect(button("bump-minor").disabled).toBe(true);
    expect(button("bump-major").getAttribute("aria-checked")).toBe("true");
    expect(button("confirm-publish").textContent).toContain("Publish v2.0");
  });

  it("closes, toasts, and refreshes the page data after a successful publish", async () => {
    h.previewPublish.mockResolvedValue({ success: true, data: REPUBLISH });
    h.publish.mockResolvedValue({ success: true, data: SUMMARY });
    renderPage({ event: published("1.0", true) });
    await open();
    await screen.findByTestId("confirm-publish");
    fireEvent.click(button("confirm-publish"));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith("Published orders v1.1"));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open and shows the error when the publish fails, so the user can try again", async () => {
    h.publish.mockResolvedValue({ success: false, error: "The event changed while publishing.", code: "CONFLICT", suggestedFix: "Reload the event and publish again." });
    renderPage();
    const dialog = await open();
    await within(dialog).findByTestId("confirm-publish");
    fireEvent.click(button("confirm-publish"));
    expect((await within(dialog).findByText(/The event changed while publishing\./)).textContent).toContain("Reload the event and publish again.");
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(button("confirm-publish").disabled).toBe(false);
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    // A second try goes through.
    h.publish.mockResolvedValue({ success: true, data: { ...SUMMARY, label: "1.0" } });
    fireEvent.click(button("confirm-publish"));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it("shows a refused publish's message when the plan is blocked at the server too", async () => {
    h.publish.mockResolvedValue({ success: false, error: "OrderCreated has no published version pinned", code: "PUBLISH_BLOCKED", details: { blockers: [] } });
    renderPage();
    const dialog = await open();
    await within(dialog).findByTestId("confirm-publish");
    fireEvent.click(button("confirm-publish"));
    expect((await within(dialog).findByText("OrderCreated has no published version pinned")).textContent).toBe("OrderCreated has no published version pinned");
    expect(screen.getByRole("dialog")).toBeDefined();
  });
});

describe("EventPage: after a publish", () => {
  it("shows the new version in the header badge and drops the Draft badge once the page data has refreshed", () => {
    const { rerender } = renderPage({ event: published("1.0", true) });
    expect(screen.getByTestId("event-version-badge").textContent).toBe("v1.0");
    expect(screen.getByTestId("event-draft-badge")).toBeDefined();
    rerender(<EventPage data={pageData({ event: published("1.1", false) })} />);
    expect(screen.getByTestId("event-version-badge").textContent).toBe("v1.1");
    expect(screen.queryByTestId("event-draft-badge")).toBeNull();
  });

  it("reloads the Versions list when a publish from the header changes the latest version", async () => {
    h.previewPublish.mockResolvedValue({ success: true, data: REPUBLISH });
    h.publish.mockResolvedValue({ success: true, data: SUMMARY });
    h.listVersions.mockResolvedValue({ success: true, data: [{ ...SUMMARY, label: "1.0", sequence: 1, changeKind: "INITIAL" }] });
    const { rerender } = renderPage({ event: published("1.0", true), initialTab: "versions" });
    await screen.findByTestId("event-version-list");
    expect(h.listVersions).toHaveBeenCalledTimes(1);
    fireEvent.click(publishButton());
    fireEvent.click(await screen.findByTestId("confirm-publish"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    h.listVersions.mockResolvedValue({ success: true, data: [SUMMARY, { ...SUMMARY, label: "1.0", sequence: 1, changeKind: "INITIAL" }] });
    rerender(<EventPage data={pageData({ event: published("1.1", false), initialTab: "versions" })} />);
    await waitFor(() => expect(within(screen.getByTestId("event-version-list")).getAllByRole("listitem")).toHaveLength(2));
    expect(h.listVersions).toHaveBeenCalledTimes(2);
  });
});

describe("EventPage: delete confirmation", () => {
  it("says only the draft goes for an event that was never published", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    fireEvent.click(button("event-delete"));
    expect(confirm.mock.calls[0][0]).toBe('Delete event "orders"? Its draft is removed with it.');
  });

  it("says the published versions go too once the event has one", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage({ event: published("1.0") });
    fireEvent.click(button("event-delete"));
    expect(confirm.mock.calls[0][0]).toBe('Delete event "orders"? Its draft and its published versions are removed with it.');
  });

  it("shows the IN_USE refusal of an event other events reference, and stays on the page", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    h.remove.mockResolvedValue({ success: false, error: 'Event "orders" is referenced by "billing".', code: "IN_USE", suggestedFix: "Remove those references first." });
    renderPage({ event: published("1.0") });
    fireEvent.click(button("event-delete"));
    const error = await screen.findByTestId("event-delete-error");
    expect(error.textContent).toContain('Event "orders" is referenced by "billing".');
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe("EventPage: the four tabs", () => {
  it("has Design, Docs, Versions and Used by, in that order", () => {
    renderPage();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Design", "Docs", "Versions", "Used by"]);
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

  it("cycles through all four with the arrow keys, wraps, and jumps with Home and End", () => {
    renderPage();
    const tab = (name: string) => screen.getByRole("tab", { name });
    const selected = () => screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent);
    fireEvent.keyDown(tab("Design"), { key: "ArrowRight" });
    expect(selected()).toEqual(["Docs"]);
    fireEvent.keyDown(tab("Docs"), { key: "ArrowRight" });
    expect(selected()).toEqual(["Versions"]);
    expect(document.activeElement).toBe(tab("Versions"));
    fireEvent.keyDown(tab("Versions"), { key: "ArrowRight" });
    expect(selected()).toEqual(["Used by"]);
    fireEvent.keyDown(tab("Used by"), { key: "ArrowRight" });
    expect(selected()).toEqual(["Design"]);
    fireEvent.keyDown(tab("Design"), { key: "ArrowLeft" });
    expect(selected()).toEqual(["Used by"]);
    fireEvent.keyDown(tab("Used by"), { key: "Home" });
    expect(selected()).toEqual(["Design"]);
    fireEvent.keyDown(tab("Design"), { key: "End" });
    expect(selected()).toEqual(["Used by"]);
    fireEvent.keyDown(tab("Used by"), { key: "a" });
    expect(selected()).toEqual(["Used by"]);
  });

  it("keeps the builder mounted behind Versions and Used by: an unsaved edit survives the trip", async () => {
    renderPage();
    const title = field("metadata-title");
    type(title, "Orders v2");
    openTab("Versions");
    await screen.findByTestId("event-versions");
    openTab("Used by");
    expect(screen.getByTestId("metadata-title")).toBe(title);
    openTab("Design");
    expect(field("metadata-title").value).toBe("Orders v2");
    expect(button("builder-save").disabled).toBe(false);
  });
});

describe("EventPage: the Versions tab", () => {
  const V11 = { ...SUMMARY, changeSummary: "Added refunds" };
  const V10 = { ...SUMMARY, id: "v0", label: "1.0", minor: 0, sequence: 1, changeKind: "INITIAL" };

  it("loads the versions when the tab opens (not before), and writes ?tab=versions", async () => {
    h.listVersions.mockResolvedValue({ success: true, data: [V11, V10] });
    renderPage({ event: published("1.1") });
    expect(h.listVersions).not.toHaveBeenCalled();
    openTab("Versions");
    expect(search()).toBe("?tab=versions");
    await screen.findByTestId("event-version-list");
    expect(h.listVersions).toHaveBeenCalledWith("ev1", "p1");
    expect(within(screen.getByTestId("event-version-list")).getAllByRole("listitem").map((li) => /v\d+\.\d+/.exec(li.textContent ?? "")?.[0])).toEqual(["v1.1", "v1.0"]);
  });

  it("View shows the stored code of that version and writes ?version= next to ?tab=", async () => {
    h.listVersions.mockResolvedValue({ success: true, data: [V11, V10] });
    renderPage({ event: published("1.1") });
    openTab("Versions");
    fireEvent.click(await screen.findByRole("button", { name: "View v1.0" }));
    await waitFor(() => expect((screen.getByTestId("event-version-code-text") as HTMLTextAreaElement).value).toContain("version: 1.0"));
    expect(h.readVersion).toHaveBeenCalledWith("ev1", "p1", "1.0");
    expect(search()).toBe("?tab=versions&version=1.0");
    fireEvent.click(screen.getByRole("button", { name: "View v1.1" }));
    await waitFor(() => expect((screen.getByTestId("event-version-code-text") as HTMLTextAreaElement).value).toContain("version: 1.1"));
    expect(search()).toBe("?tab=versions&version=1.1");
  });

  it("drops ?version= when another tab shows and brings the selected version back with the tab", async () => {
    h.listVersions.mockResolvedValue({ success: true, data: [V11, V10] });
    renderPage({ event: published("1.1") });
    openTab("Versions");
    fireEvent.click(await screen.findByRole("button", { name: "View v1.1" }));
    await waitFor(() => expect(search()).toBe("?tab=versions&version=1.1"));
    openTab("Design");
    expect(search()).toBe("");
    openTab("Versions");
    expect(search()).toBe("?tab=versions&version=1.1");
    await waitFor(() => expect((screen.getByTestId("event-version-code-text") as HTMLTextAreaElement).value).toContain("version: 1.1"));
  });

  it("opens straight on the version named by the page data (?tab=versions&version=1.0)", async () => {
    window.history.replaceState(null, "", `${EVENT_URL}?tab=versions&version=1.0`);
    h.listVersions.mockResolvedValue({ success: true, data: [V11, V10] });
    renderPage({ event: published("1.1"), initialTab: "versions", initialVersion: "1.0" });
    await waitFor(() => expect((screen.getByTestId("event-version-code-text") as HTMLTextAreaElement).value).toContain("version: 1.0"));
    expect(search()).toBe("?tab=versions&version=1.0");
  });

  it("keeps the list when a version cannot be loaded", async () => {
    h.listVersions.mockResolvedValue({ success: true, data: [V11, V10] });
    h.readVersion.mockResolvedValue({ success: false, error: "Stored document of version 1.1 is invalid", code: "DATA_CORRUPT" });
    renderPage({ event: published("1.1") });
    openTab("Versions");
    fireEvent.click(await screen.findByRole("button", { name: "View v1.1" }));
    expect((await screen.findByTestId("event-version-code-error")).textContent).toContain("Stored document of version 1.1 is invalid");
    expect(within(screen.getByTestId("event-version-list")).getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("EventPage: the Used by tab", () => {
  it("looks up the event's referrers when the tab opens (not before) and writes ?tab=used-by", async () => {
    renderPage();
    expect(h.listUsages).not.toHaveBeenCalled();
    openTab("Used by");
    expect(search()).toBe("?tab=used-by");
    expect(await screen.findByText("No other event references this one.")).toBeDefined();
    expect(h.listUsages).toHaveBeenCalledTimes(1);
    expect(h.listUsages).toHaveBeenCalledWith({ kind: "event", eventId: "ev1" });
    expect(screen.getByTestId("used-by-panel").textContent).toContain("Used by");
  });

  it("lists the events that reference this one, and says when the list was cut", async () => {
    h.listUsages.mockResolvedValue({
      success: true,
      data: {
        rows: [{ id: "r1", fromKind: "EVENT_SPEC_VERSION", role: "CHANNEL", isDraft: false, target: "orders v1.0", label: "Event billing v1.2", href: "/schemas/payments/billing/events/ev9" }],
        truncated: true,
      },
    });
    renderPage({ initialTab: "used-by" });
    const link = await screen.findByRole("link", { name: "Event billing v1.2" });
    expect(link.getAttribute("href")).toBe("/schemas/payments/billing/events/ev9");
    expect(screen.getByText("Showing the first 50 references.")).toBeDefined();
  });

  it("shows the lookup's error and keeps the page usable", async () => {
    h.listUsages.mockResolvedValue({ success: false, error: "Could not load usages. Try again.", code: "DB_ERROR" });
    renderPage({ initialTab: "used-by" });
    const used = within(screen.getByTestId("event-panel-used-by"));
    expect((await used.findByRole("alert")).textContent).toBe("Could not load usages. Try again.");
    expect(publishButton().disabled).toBe(false);
  });
});
