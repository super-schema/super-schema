// @vitest-environment jsdom
// ExternalRefsCard: the references of one kind under the Channels / Messages list: what each points at, whether its source event has
// moved on, Update (re-point, or refuse, or remove) and Remove (with its impact). The read actions are mocked.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ statuses: vi.fn(), items: vi.fn(), candidates: vi.fn(), versions: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  getExternalRefStatusesAction: h.statuses,
  getExternalVersionItemsAction: h.items,
  listExternalEventCandidatesAction: h.candidates,
  listExternalEventVersionsAction: h.versions,
}));

import type { SectionProps } from "@/features/events/builder/EventBuilder";
import { ExternalRefsCard } from "@/features/events/builder/sections/ExternalRefsCard";
import type { DocExternalRef, DocumentProblem, EventDocument } from "@/lib/events/document/types";
import type { ExternalItemKind, ExternalRefInput, ExternalRefStatus } from "@/lib/events/external-refs";
import { renderSection, sampleDocument } from "./builder-harness";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const MSG: DocExternalRef = { key: "Order-placed", eventVersionId: "vv1", kind: "message", itemKey: "OrderPlaced" };
const CHAN: DocExternalRef = { key: "billing-topic", eventVersionId: "vv1", kind: "channel", itemKey: "billing" };

const status = (over: Partial<ExternalRefStatus> = {}): ExternalRefStatus => ({
  eventVersionId: "vv1", eventId: "ev-orders", eventName: "orders", label: "1.0", latestVersionId: "vv2", latestLabel: "2.0",
  newerAvailable: true, newerIsMajor: true, itemsMissingInLatest: [], ...over,
});
/** vv1 has a newer version (`vv1Status` overrides it); any other version is the latest. */
function answerStatuses(vv1Status: Partial<ExternalRefStatus> = {}) {
  h.statuses.mockImplementation(async (_productId: string, refs: ExternalRefInput[]) => ({
    success: true,
    data: [...new Set(refs.map((r) => r.eventVersionId))].map((id) => (id === "vv1"
      ? status(vv1Status)
      : status({ eventVersionId: id, label: "2.0", latestVersionId: id, latestLabel: "2.0", newerAvailable: false, newerIsMajor: false }))),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  answerStatuses();
  h.items.mockResolvedValue({
    success: true,
    data: { eventName: "orders", label: "1.0", channels: [{ key: "billing", title: "Billing topic" }], messages: [{ key: "OrderPlaced", title: "Order placed" }] },
  });
  h.candidates.mockResolvedValue({ success: true, data: [] });
  h.versions.mockResolvedValue({ success: true, data: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A document with the given references. `used` also wires them in: the message into a channel and an operation, the channel into an operation. */
function docWith(refs: DocExternalRef[], used: { message?: boolean; channel?: boolean } = {}): EventDocument {
  const d = sampleDocument();
  d.externalRefs = refs;
  const message = refs.find((r) => r.kind === "message");
  const channel = refs.find((r) => r.kind === "channel");
  if (used.message && message) {
    d.channels[0] = { ...d.channels[0], messageKeys: [...d.channels[0].messageKeys, message.key] };
    d.operations.push({ key: "receivePlaced", action: "receive", channelKey: "orders", messageKeys: [message.key], traitKeys: [] });
    d.operations.push({ key: "auditPlaced", action: "receive", channelKey: "orders", messageKeys: [message.key], traitKeys: [] });
  }
  if (used.channel && channel) {
    d.operations.push({ key: "receiveBilling", action: "receive", channelKey: channel.key, messageKeys: [], traitKeys: [] });
  }
  return d;
}

function hostFor(kind: ExternalItemKind, problems?: DocumentProblem[]): ComponentType<SectionProps> {
  return function Host({ draft }: SectionProps) {
    return <ExternalRefsCard kind={kind} draft={draft} problems={problems ?? draft.problems} />;
  };
}
function renderCard(kind: ExternalItemKind, doc: EventDocument, problems?: DocumentProblem[]) {
  return renderSection(hostFor(kind, problems), { doc });
}

const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const text = (testId: string) => screen.getByTestId(testId).textContent ?? "";
const missing = (testId: string) => screen.queryByTestId(testId) === null;
/** Wait for the status of a row to be drawn. */
const statusOf = (key: string) => screen.findByTestId(`external-ref-status-${key}`);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe("ExternalRefsCard: empty", () => {
  it("offers one primary action, 'Add from another event', and asks nothing of the server", async () => {
    renderCard("message", docWith([]));
    expect(text("external-refs-empty")).toContain("Messages from other events");
    const add = screen.getByTestId("external-ref-add");
    expect(add.textContent).toContain("Add from another event");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await settle();
    expect(h.statuses).not.toHaveBeenCalled();
    expect(h.items).not.toHaveBeenCalled();
  });

  it("says channels in the Channels section", () => {
    renderCard("channel", docWith([]));
    expect(text("external-refs-empty")).toContain("Channels from other events");
  });

  it("shows no empty state, only the quiet add button, when this kind has references", async () => {
    renderCard("message", docWith([MSG]));
    await screen.findByTestId("external-ref-row-Order-placed");
    expect(missing("external-refs-empty")).toBe(true);
    expect(text("external-ref-add")).toContain("Add from another event");
  });
});

describe("ExternalRefsCard: the references", () => {
  it("lists only this kind, each with its source event, version, item title, an External badge and Remove", async () => {
    renderCard("message", docWith([MSG, CHAN]));
    const row = await screen.findByTestId("external-ref-row-Order-placed");
    await waitFor(() => expect(row.textContent).toContain("Order placed"));
    expect(row.textContent).toContain("orders");
    expect(row.textContent).toContain("v1.0");
    expect(text("external-ref-badge-Order-placed")).toBe("External");
    expect(text("external-ref-remove-Order-placed")).toContain("Remove");
    expect(missing("external-ref-row-billing-topic")).toBe(true);
  });

  it("shows the channels in the channel card", async () => {
    renderCard("channel", docWith([MSG, CHAN]));
    const row = await screen.findByTestId("external-ref-row-billing-topic");
    await waitFor(() => expect(row.textContent).toContain("Billing topic"));
    expect(missing("external-ref-row-Order-placed")).toBe(true);
  });

  it("falls back to the item's key when its details cannot be loaded", async () => {
    h.items.mockResolvedValue({ success: false, error: "not found", code: "NOT_FOUND" });
    renderCard("message", docWith([MSG]));
    const row = await screen.findByTestId("external-ref-row-Order-placed");
    await settle();
    expect(row.textContent).toContain("OrderPlaced");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks for the status of every reference of the document, not only this kind's", async () => {
    renderCard("message", docWith([MSG, CHAN]));
    await statusOf("Order-placed");
    expect(h.statuses).toHaveBeenCalledTimes(1);
    expect(h.statuses).toHaveBeenCalledWith("p1", [
      { eventVersionId: "vv1", kind: "message", itemKey: "OrderPlaced" },
      { eventVersionId: "vv1", kind: "channel", itemKey: "billing" },
    ]);
  });

  it("shows a problem the document reports for the reference under it (pointer by position in the whole list)", async () => {
    renderCard("channel", docWith([MSG, CHAN]), [{ pointer: "/externalRefs/1/itemKey", message: 'Item "billing" is not in that version' }]);
    const row = await screen.findByTestId("external-ref-row-billing-topic");
    expect(row.textContent).toContain('Item "billing" is not in that version');
    expect(missing("external-ref-problem-Order-placed")).toBe(true);
  });
});

describe("ExternalRefsCard: newer version", () => {
  it("says 'v1.0 → v2.0 available' and calls a major out", async () => {
    renderCard("message", docWith([MSG]));
    const line = await statusOf("Order-placed");
    expect(line.textContent).toContain("v1.0 → v2.0 available");
    expect(line.textContent).toContain("Major");
    expect(text("external-ref-update-Order-placed")).toContain("Update to v2.0");
  });

  it("does not call a minor a major", async () => {
    answerStatuses({ newerIsMajor: false, latestLabel: "1.1" });
    renderCard("message", docWith([MSG]));
    const line = await statusOf("Order-placed");
    expect(line.textContent).toContain("v1.0 → v1.1 available");
    expect(line.textContent).not.toContain("Major");
  });

  it("shows nothing for a reference that is already on the latest version", async () => {
    answerStatuses({ newerAvailable: false, newerIsMajor: false, latestVersionId: "vv1", latestLabel: "1.0" });
    renderCard("message", docWith([MSG]));
    await waitFor(() => expect(h.statuses).toHaveBeenCalled());
    await settle();
    expect(missing("external-ref-status-Order-placed")).toBe(true);
    expect(missing("external-ref-update-Order-placed")).toBe(true);
  });

  it("shows no status, no banner and no retry when the status cannot be loaded (the whole call fails)", async () => {
    h.statuses.mockResolvedValue({ success: false, error: 'Event version "vv1" not found', code: "NOT_FOUND" });
    renderCard("message", docWith([MSG]));
    await screen.findByTestId("external-ref-row-Order-placed");
    await settle();
    await settle();
    expect(missing("external-ref-status-Order-placed")).toBe(true);
    expect(missing("external-ref-update-Order-placed")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("external-ref-row-Order-placed").textContent).toContain("External");
    expect(h.statuses).toHaveBeenCalledTimes(1);
  });

  it("treats a rejected status call the same way", async () => {
    h.statuses.mockRejectedValue(new Error("boom"));
    renderCard("message", docWith([MSG]));
    await screen.findByTestId("external-ref-row-Order-placed");
    await settle();
    expect(missing("external-ref-status-Order-placed")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(h.statuses).toHaveBeenCalledTimes(1);
  });

  it("asks again when the references change, and not otherwise", async () => {
    const { probe } = renderCard("message", docWith([MSG]));
    await statusOf("Order-placed");
    expect(h.statuses).toHaveBeenCalledTimes(1);
    // A rename changes no version, kind or item: nothing to ask.
    act(() => probe.draft.update((d) => ({ ...d, externalRefs: d.externalRefs.map((r) => ({ ...r, key: "renamed" })) })));
    await settle();
    expect(h.statuses).toHaveBeenCalledTimes(1);
    act(() => probe.draft.update((d) => ({ ...d, externalRefs: [...d.externalRefs, { key: "x", eventVersionId: "vv9", kind: "message", itemKey: "Other" }] })));
    await waitFor(() => expect(h.statuses).toHaveBeenCalledTimes(2));
  });
});

describe("ExternalRefsCard: Update", () => {
  it("re-points the reference to the latest version and asks for the status again", async () => {
    const { probe } = renderCard("message", docWith([MSG, CHAN]));
    await statusOf("Order-placed");
    click("external-ref-update-Order-placed");
    expect(probe.draft.doc.externalRefs).toEqual([{ ...MSG, eventVersionId: "vv2" }, CHAN]);
    expect(probe.draft.dirty).toBe(true);
    await waitFor(() => expect(h.statuses).toHaveBeenCalledTimes(2));
    expect(h.statuses.mock.calls[1][1]).toEqual([
      { eventVersionId: "vv2", kind: "message", itemKey: "OrderPlaced" },
      { eventVersionId: "vv1", kind: "channel", itemKey: "billing" },
    ]);
    await waitFor(() => expect(missing("external-ref-status-Order-placed")).toBe(true));
  });

  it("re-points a reference that an operation uses when the latest version still has the item", async () => {
    const { probe } = renderCard("message", docWith([MSG], { message: true }));
    await statusOf("Order-placed");
    click("external-ref-update-Order-placed");
    expect(probe.draft.doc.externalRefs[0].eventVersionId).toBe("vv2");
    expect(probe.draft.doc.operations.map((o) => o.messageKeys)).toEqual([["OrderCreated"], ["Order-placed"], ["Order-placed"]]);
  });

  it("refuses, with an inline message, when the latest version dropped the item and an operation uses it", async () => {
    answerStatuses({ itemsMissingInLatest: ["OrderPlaced"] });
    const before = docWith([MSG], { message: true });
    const { probe } = renderCard("message", before);
    await statusOf("Order-placed");
    click("external-ref-update-Order-placed");
    const refused = text("external-ref-refused-Order-placed");
    expect(refused).toContain("v2.0");
    expect(refused).toContain('"OrderPlaced"');
    expect(refused).toContain('"receivePlaced"');
    expect(refused).toContain('"auditPlaced"');
    expect(probe.draft.doc).toEqual(before);
    expect(probe.draft.dirty).toBe(false);
  });

  it("removes a dropped item nobody uses, with a note", async () => {
    answerStatuses({ itemsMissingInLatest: ["OrderPlaced"] });
    const { probe } = renderCard("message", docWith([MSG]));
    await statusOf("Order-placed");
    click("external-ref-update-Order-placed");
    expect(probe.draft.doc.externalRefs).toEqual([]);
    const note = text("external-refs-note");
    expect(note).toContain('"OrderPlaced"');
    expect(note).toContain("v2.0");
    expect(missing("external-ref-row-Order-placed")).toBe(true);
    // The card stays, with its empty state, so the note has somewhere to be.
    expect(text("external-refs-empty")).toContain("Messages from other events");
  });

  it("a channel and a message that share an item key: the listed key refuses only the reference an operation uses", async () => {
    const message: DocExternalRef = { key: "m-orders", eventVersionId: "vv1", kind: "message", itemKey: "orders" };
    const channel: DocExternalRef = { key: "c-orders", eventVersionId: "vv1", kind: "channel", itemKey: "orders" };
    answerStatuses({ itemsMissingInLatest: ["orders"] });
    // Only the channel reference is used by an operation.
    const doc = docWith([message, channel], { channel: true });
    doc.operations = doc.operations.map((o) => (o.key === "receiveBilling" ? { ...o, channelKey: "c-orders" } : o));
    doc.operations.push({ key: "receiveOrders", action: "receive", channelKey: "c-orders", messageKeys: [], traitKeys: [] });

    // The channel card: used and listed -> refused.
    const { probe } = renderCard("channel", doc);
    await statusOf("c-orders");
    click("external-ref-update-c-orders");
    expect(text("external-ref-refused-c-orders")).toContain('"receiveOrders"');
    expect(probe.draft.dirty).toBe(false);
    cleanup();

    // The message card: listed, but no operation uses the message reference -> removed with a note, never refused.
    const second = renderCard("message", doc);
    await statusOf("m-orders");
    click("external-ref-update-m-orders");
    expect(missing("external-ref-refused-m-orders")).toBe(true);
    expect(second.probe.draft.doc.externalRefs.map((r) => r.key)).toEqual(["c-orders"]);
    expect(text("external-refs-note")).toContain('"orders"');
  });

  it("re-points a used reference whose key is not listed, even if another reference of the version is", async () => {
    answerStatuses({ itemsMissingInLatest: ["billing"] });
    const { probe } = renderCard("message", docWith([MSG, CHAN], { message: true, channel: true }));
    await statusOf("Order-placed");
    click("external-ref-update-Order-placed");
    expect(probe.draft.doc.externalRefs.find((r) => r.key === "Order-placed")?.eventVersionId).toBe("vv2");
    expect(missing("external-ref-refused-Order-placed")).toBe(true);
  });

  it("clears an earlier refusal or note once something else is edited through the card", async () => {
    answerStatuses({ itemsMissingInLatest: ["OrderPlaced"] });
    renderCard("message", docWith([MSG], { message: true }));
    await statusOf("Order-placed");
    click("external-ref-update-Order-placed");
    expect(missing("external-ref-refused-Order-placed")).toBe(false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    click("external-ref-remove-Order-placed");
    expect(missing("external-ref-refused-Order-placed")).toBe(true);
  });
});

describe("ExternalRefsCard: Remove", () => {
  it("removes a reference nothing uses at once, without asking", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderCard("message", docWith([MSG, CHAN]));
    await screen.findByTestId("external-ref-row-Order-placed");
    expect(missing("external-ref-usage-Order-placed")).toBe(true);
    click("external-ref-remove-Order-placed");
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.draft.doc.externalRefs).toEqual([CHAN]);
    expect(probe.draft.dirty).toBe(true);
  });

  it("shows what uses a reference, and asks first with the impact before removing it from the channels and operations that use it", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderCard("message", docWith([MSG], { message: true }));
    await screen.findByTestId("external-ref-row-Order-placed");
    expect(text("external-ref-usage-Order-placed")).toBe("Used by 1 channel and 2 operations");
    click("external-ref-remove-Order-placed");
    expect(confirm).toHaveBeenCalledTimes(1);
    const question = String(confirm.mock.calls[0][0]);
    expect(question).toContain('"Order-placed"');
    expect(question).toContain("2 operations (receivePlaced, auditPlaced)");
    expect(question).toContain("1 channel (orders)");
    expect(probe.draft.doc.externalRefs).toEqual([]);
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderCreated"]);
    expect(probe.draft.doc.operations.map((o) => o.messageKeys)).toEqual([["OrderCreated"], [], []]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("changes nothing when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const doc = docWith([MSG], { message: true });
    const { probe } = renderCard("message", doc);
    await screen.findByTestId("external-ref-row-Order-placed");
    click("external-ref-remove-Order-placed");
    expect(probe.draft.doc).toEqual(doc);
    expect(probe.draft.dirty).toBe(false);
  });

  it("removing a channel reference an operation uses deletes those operations, as removing a local channel does", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderCard("channel", docWith([CHAN], { channel: true }));
    await screen.findByTestId("external-ref-row-billing-topic");
    expect(text("external-ref-usage-billing-topic")).toBe("Used by 1 operation");
    click("external-ref-remove-billing-topic");
    const question = String(confirm.mock.calls[0][0]);
    expect(question).toContain("delete");
    expect(question).toContain("receiveBilling");
    expect(probe.draft.doc.externalRefs).toEqual([]);
    expect(probe.draft.doc.operations.map((o) => o.key)).toEqual(["publishOrder"]);
    expect(probe.draft.problems).toEqual([]);
  });
});

describe("ExternalRefsCard: add", () => {
  it("opens the picker; choosing an event, version and message appends the reference and closes it", async () => {
    h.candidates.mockResolvedValue({
      success: true,
      data: [{ eventId: "ev-orders", eventName: "orders", domainName: "Payments", productName: "Checkout", latestVersionId: "vv2", latestLabel: "2.0" }],
    });
    h.versions.mockResolvedValue({ success: true, data: [{ versionId: "vv2", label: "2.0", publishedAt: "2026-10-16T10:00:00.000Z" }] });
    h.items.mockResolvedValue({
      success: true,
      data: { eventName: "orders", label: "2.0", channels: [], messages: [{ key: "OrderPlaced", title: "Order placed" }] },
    });
    const { probe } = renderCard("message", docWith([]));
    click("external-ref-add");
    fireEvent.click(await screen.findByTestId("external-ref-event-ev-orders"));
    await screen.findByTestId("external-ref-versions");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByTestId("external-ref-item-OrderPlaced"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(h.candidates).toHaveBeenCalledWith("p1", "ev1", undefined);
    expect(probe.draft.doc.externalRefs).toEqual([{ key: "Order-placed", eventVersionId: "vv2", kind: "message", itemKey: "OrderPlaced" }]);
    expect(probe.draft.dirty).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("external-ref-picker")).toBeNull());
    expect(await screen.findByTestId("external-ref-row-Order-placed")).toBeDefined();
  });
});
