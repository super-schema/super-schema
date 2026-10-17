// @vitest-environment jsdom
// ExternalRefPicker: the three-step dialog (event -> version -> channel or message) that adds an external reference. The read actions
// are mocked; what is pinned here is what the dialog asks of them, what it offers, and the reference it hands back.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ candidates: vi.fn(), versions: vi.fn(), items: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  listExternalEventCandidatesAction: h.candidates,
  listExternalEventVersionsAction: h.versions,
  getExternalVersionItemsAction: h.items,
}));

import { ExternalRefPicker, SEARCH_DEBOUNCE_MS } from "@/features/events/builder/sections/ExternalRefPicker";
import { emptyEventDocument, type DocExternalRef, type EventDocument } from "@/lib/events/document/types";
import type { ExternalEventCandidate, ExternalItemKind, ExternalVersionItems, ExternalVersionOption } from "@/lib/events/external-refs";

// cmdk measures its list and scrolls the selected item into view; jsdom has neither.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const ORDERS: ExternalEventCandidate = { eventId: "ev-orders", eventName: "orders", domainName: "Payments", productName: "Checkout", latestVersionId: "vv-orders-2", latestLabel: "2.0" };
const SHIPPING: ExternalEventCandidate = { eventId: "ev-shipping", eventName: "shipping", domainName: "Logistics", productName: "Dispatch", latestVersionId: "vv-ship-1", latestLabel: "1.0" };
/** Newest first, as the loader returns them. */
const VERSIONS: ExternalVersionOption[] = [
  { versionId: "vv-orders-2", label: "2.0", publishedAt: "2026-10-16T10:00:00.000Z" },
  { versionId: "vv-orders-1", label: "1.0", publishedAt: "2026-10-01T10:00:00.000Z" },
];
const ITEMS: ExternalVersionItems = {
  eventName: "orders",
  label: "2.0",
  channels: [{ key: "orders-topic", title: "Orders topic", summary: "Where orders travel" }],
  messages: [
    { key: "OrderCreated", title: "Order created", summary: "An order was placed" },
    { key: "OrderCancelled" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.candidates.mockImplementation(async (_productId: string, _eventId: string, query?: string) => ({
    success: true,
    data: [ORDERS, SHIPPING].filter((c) => !query || c.eventName.includes(query.toLowerCase())),
  }));
  h.versions.mockResolvedValue({ success: true, data: VERSIONS });
  h.items.mockResolvedValue({ success: true, data: ITEMS });
});
afterEach(cleanup);

function doc(refs: DocExternalRef[] = []): EventDocument {
  return { ...emptyEventDocument("billing"), externalRefs: refs };
}

function setup(props: { kind?: ExternalItemKind; doc?: EventDocument } = {}) {
  const onAdd = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ExternalRefPicker
      open onOpenChange={onOpenChange} productId="p1" eventId="ev1" kind={props.kind ?? "message"} doc={props.doc ?? doc()} onAdd={onAdd}
    />,
  );
  return { onAdd, onOpenChange };
}

const eventRow = (id: string) => screen.findByTestId(`external-ref-event-${id}`);
const itemRow = (key: string) => screen.findByTestId(`external-ref-item-${key}`);
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

/** Step 1 -> 2: choose the "orders" event. */
async function chooseOrders() {
  fireEvent.click(await eventRow("ev-orders"));
  await screen.findByTestId("external-ref-versions");
}
/** Step 1 -> 3 with the preselected (newest) version. */
async function toItems() {
  await chooseOrders();
  fireEvent.click(button("Next"));
  await itemRow("OrderCreated");
}

describe("ExternalRefPicker: step 1, the event", () => {
  it("is a dialog that lists the published events of the other products, with where they live and their latest version", async () => {
    setup();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByTestId("external-ref-picker").textContent).toContain("Add a message from another event");
    expect(screen.getByTestId("external-ref-picker").textContent).toContain("Step 1 of 3");
    const row = await eventRow("ev-orders");
    expect(row.textContent).toContain("orders");
    expect(row.textContent).toContain("Payments / Checkout");
    expect(row.textContent).toContain("v2.0");
    expect((await eventRow("ev-shipping")).textContent).toContain("Logistics / Dispatch");
  });

  it("asks for the first page with no query, naming the event being edited so it is left out", async () => {
    setup();
    await eventRow("ev-orders");
    expect(h.candidates).toHaveBeenCalledWith("p1", "ev1", undefined);
  });

  it("searches with the typed text once typing pauses, sending the same event id again", async () => {
    setup();
    await eventRow("ev-orders");
    fireEvent.change(screen.getByTestId("external-ref-search"), { target: { value: "ship" } });
    // Not on every keystroke: the call waits for the pause.
    expect(h.candidates).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.candidates).toHaveBeenLastCalledWith("p1", "ev1", "ship"), { timeout: SEARCH_DEBOUNCE_MS + 1500 });
    await waitFor(() => expect(screen.queryByTestId("external-ref-event-ev-orders")).toBeNull());
    expect(await eventRow("ev-shipping")).toBeDefined();
  });

  it("never offers the event being edited, even if the loader returned it", async () => {
    h.candidates.mockResolvedValue({
      success: true,
      data: [ORDERS, { ...SHIPPING, eventId: "ev1", eventName: "billing" }],
    });
    setup();
    await eventRow("ev-orders");
    expect(screen.queryByTestId("external-ref-event-ev1")).toBeNull();
    expect(screen.getByTestId("external-ref-picker").textContent).not.toContain("billing");
  });

  it("says so when nothing matches", async () => {
    h.candidates.mockResolvedValue({ success: true, data: [] });
    setup();
    expect((await screen.findByTestId("external-ref-events-empty")).textContent).toContain("No other event has been published yet.");
  });

  it("shows why the events could not be loaded instead of an empty list", async () => {
    h.candidates.mockResolvedValue({ success: false, error: "Forbidden", code: "FORBIDDEN" });
    setup();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load published events");
    expect(alert.textContent).toContain("Forbidden");
  });

  it("never prints the cause of a rejected action", async () => {
    h.candidates.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    setup();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("ECONNREFUSED");
    expect(alert.textContent).toContain("Something went wrong");
  });

  it("cancels without adding anything", async () => {
    const { onAdd, onOpenChange } = setup();
    await eventRow("ev-orders");
    fireEvent.click(button("Cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("ExternalRefPicker: step 2, the version", () => {
  it("loads the versions of the chosen event and preselects the newest", async () => {
    setup();
    await chooseOrders();
    expect(h.versions).toHaveBeenCalledWith("p1", "ev-orders");
    expect(screen.getByTestId("external-ref-picker").textContent).toContain("Step 2 of 3");
    const radios = within(screen.getByTestId("external-ref-versions")).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(screen.getByTestId("external-ref-version-vv-orders-2").textContent).toContain("v2.0");
    expect(screen.getByTestId("external-ref-version-vv-orders-2").textContent).toContain("Latest");
    expect(screen.getByTestId("external-ref-version-vv-orders-1").textContent).toContain("v1.0");
    expect(screen.getByTestId("external-ref-version-vv-orders-1").textContent).toContain("Published 2026-10-01");
  });

  it("lets the user pick an older version and loads that version's items", async () => {
    setup();
    await chooseOrders();
    fireEvent.click(within(screen.getByTestId("external-ref-version-vv-orders-1")).getByRole("radio"));
    fireEvent.click(button("Next"));
    await itemRow("OrderCreated");
    expect(h.items).toHaveBeenCalledWith("p1", "vv-orders-1");
  });

  it("goes back to the events with the search still there", async () => {
    setup();
    await chooseOrders();
    fireEvent.click(button("Back"));
    expect(await eventRow("ev-orders")).toBeDefined();
    expect(screen.getByTestId("external-ref-picker").textContent).toContain("Step 1 of 3");
  });

  it("explains an event with no referenceable version and does not let the user go on", async () => {
    h.versions.mockResolvedValue({ success: true, data: [] });
    setup();
    fireEvent.click(await eventRow("ev-orders"));
    expect((await screen.findByTestId("external-ref-versions-empty")).textContent).toContain("no version that can be referenced");
    expect(button("Next").disabled).toBe(true);
  });
});

describe("ExternalRefPicker: step 3, the item", () => {
  it("lists the messages of the chosen version with their key, title and summary, and no channel", async () => {
    setup();
    await toItems();
    expect(h.items).toHaveBeenCalledWith("p1", "vv-orders-2");
    expect(screen.getByTestId("external-ref-picker").textContent).toContain("Step 3 of 3");
    const created = screen.getByTestId("external-ref-item-OrderCreated").textContent ?? "";
    expect(created).toContain("OrderCreated");
    expect(created).toContain("Order created");
    expect(created).toContain("An order was placed");
    expect(screen.getByTestId("external-ref-item-OrderCancelled").textContent).toContain("OrderCancelled");
    expect(screen.queryByTestId("external-ref-item-orders-topic")).toBeNull();
  });

  it("lists the channels, and no message, when the picker is for channels", async () => {
    setup({ kind: "channel" });
    expect(screen.getByTestId("external-ref-picker").textContent).toContain("Add a channel from another event");
    await chooseOrders();
    fireEvent.click(button("Next"));
    expect((await itemRow("orders-topic")).textContent).toContain("Orders topic");
    expect(screen.queryByTestId("external-ref-item-OrderCreated")).toBeNull();
  });

  it("disables the items this event already references and cannot choose one", async () => {
    const used: DocExternalRef = { key: "Order-created", eventVersionId: "vv-orders-2", kind: "message", itemKey: "OrderCreated" };
    setup({ doc: doc([used]) });
    await toItems();
    const row = screen.getByTestId("external-ref-item-OrderCreated");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Already used");
    expect(screen.getByTestId("external-ref-item-OrderCancelled").getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(row);
    expect(button("Add").disabled).toBe(true);
    expect(screen.queryByTestId("external-ref-key-disclosure")).toBeNull();
  });

  it("does not disable an item of the same event that another version offers, nor an item of the other kind", async () => {
    const other: DocExternalRef[] = [
      { key: "old-created", eventVersionId: "vv-orders-1", kind: "message", itemKey: "OrderCreated" },
      { key: "OrderCreated", eventVersionId: "vv-orders-2", kind: "channel", itemKey: "OrderCreated" },
    ];
    setup({ doc: doc(other) });
    await toItems();
    expect(screen.getByTestId("external-ref-item-OrderCreated").getAttribute("aria-disabled")).toBe("false");
  });

  it("says when the version has nothing of this kind", async () => {
    h.items.mockResolvedValue({ success: true, data: { ...ITEMS, messages: [] } });
    setup();
    await chooseOrders();
    fireEvent.click(button("Next"));
    expect((await screen.findByTestId("external-ref-items-empty")).textContent).toContain("Version v2.0 has no messages to use.");
  });

  it("shows why the items could not be loaded", async () => {
    h.items.mockResolvedValue({ success: false, error: "Event version not found", code: "NOT_FOUND" });
    setup();
    await chooseOrders();
    fireEvent.click(button("Next"));
    expect((await screen.findByRole("alert")).textContent).toContain("Event version not found");
  });

  it("keeps Add disabled until an item is chosen", async () => {
    setup();
    await toItems();
    expect(button("Add").disabled).toBe(true);
    fireEvent.click(screen.getByTestId("external-ref-item-OrderCreated"));
    expect(button("Add").disabled).toBe(false);
  });
});

describe("ExternalRefPicker: focus follows the steps", () => {
  // Choosing an event, Next and Back unmount the control that had focus: the new step's primary control must take it, or a keyboard
  // user lands on <body> inside a dialog.
  const checkedRadio = () => within(screen.getByTestId("external-ref-versions")).getAllByRole("radio").find((r) => (r as HTMLInputElement).checked) as HTMLInputElement;

  it("moves to the preselected version when an event is chosen (once the versions are listed)", async () => {
    setup();
    await chooseOrders();
    await waitFor(() => expect(document.activeElement).toBe(checkedRadio()), { timeout: 5000 });
    expect(checkedRadio().value).toBe("vv-orders-2");
  });

  it("moves to the version the user had picked when coming back from step 3", async () => {
    setup();
    await chooseOrders();
    fireEvent.click(within(screen.getByTestId("external-ref-version-vv-orders-1")).getByRole("radio"));
    fireEvent.click(button("Next"));
    await itemRow("OrderCreated");
    fireEvent.click(button("Back"));
    await screen.findByTestId("external-ref-versions");
    await waitFor(() => expect(document.activeElement).toBe(checkedRadio()), { timeout: 5000 });
    expect(checkedRadio().value).toBe("vv-orders-1");
  });

  it("moves to the filter of the items on Next", async () => {
    setup();
    await toItems();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("external-ref-items-filter")), { timeout: 5000 });
  });

  it("moves back to the search of the events on Back from step 2", async () => {
    setup();
    await chooseOrders();
    fireEvent.click(button("Back"));
    await eventRow("ev-orders");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("external-ref-search")), { timeout: 5000 });
  });

  it("does not take focus when the versions could not be listed, and does not steal it later", async () => {
    h.versions.mockResolvedValue({ success: false, error: "Forbidden", code: "FORBIDDEN" });
    setup();
    fireEvent.click(await eventRow("ev-orders"));
    await screen.findByRole("alert");
    const back = button("Back");
    back.focus();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).toBe(back);
  });
});

describe("ExternalRefPicker: confirm", () => {
  it("adds { key, eventVersionId, kind, itemKey } with a key made from the item's title, then closes", async () => {
    const { onAdd, onOpenChange } = setup();
    await toItems();
    fireEvent.click(screen.getByTestId("external-ref-item-OrderCreated"));
    fireEvent.click(button("Add"));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({ key: "Order-created", eventVersionId: "vv-orders-2", kind: "message", itemKey: "OrderCreated" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("makes the key from the item's own key when it has no title", async () => {
    const { onAdd } = setup();
    await toItems();
    fireEvent.click(screen.getByTestId("external-ref-item-OrderCancelled"));
    fireEvent.click(button("Add"));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ key: "OrderCancelled", itemKey: "OrderCancelled" }));
  });

  it("makes the key unique across the event: local channels and messages and other references count", async () => {
    const taken = doc([{ key: "Order-created", eventVersionId: "vv-x", kind: "channel", itemKey: "x" }]);
    taken.messages = [{ key: "Order-created-2", payload: { entityId: "e", entityVersionId: "v" }, traitKeys: [] }];
    const { onAdd } = setup({ doc: taken });
    await toItems();
    fireEvent.click(screen.getByTestId("external-ref-item-OrderCreated"));
    expect(screen.getByTestId("external-ref-key-value").textContent).toBe("Order-created-3");
    fireEvent.click(button("Add"));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ key: "Order-created-3" }));
  });

  it("keeps the generated key behind a collapsed Identifier, where it can be renamed", async () => {
    const { onAdd } = setup();
    await toItems();
    fireEvent.click(screen.getByTestId("external-ref-item-OrderCreated"));
    const details = screen.getByTestId("external-ref-key-disclosure") as HTMLDetailsElement;
    expect(details.tagName).toBe("DETAILS");
    expect(details.open).toBe(false);
    const input = screen.getByTestId("external-ref-key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "placed-orders" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("external-ref-key-value").textContent).toBe("placed-orders");
    fireEvent.click(button("Add"));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ key: "placed-orders" }));
  });

  it("refuses a key that is already taken and keeps the generated one", async () => {
    const taken = doc([{ key: "mine", eventVersionId: "vv-x", kind: "channel", itemKey: "x" }]);
    const { onAdd } = setup({ doc: taken });
    await toItems();
    fireEvent.click(screen.getByTestId("external-ref-item-OrderCreated"));
    const input = screen.getByTestId("external-ref-key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mine" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("external-ref-key-error").textContent).toContain("already used");
    fireEvent.click(button("Add"));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ key: "Order-created" }));
  });

  it("adds a channel reference with kind channel", async () => {
    const { onAdd } = setup({ kind: "channel" });
    await chooseOrders();
    fireEvent.click(button("Next"));
    fireEvent.click(await itemRow("orders-topic"));
    fireEvent.click(button("Add"));
    expect(onAdd).toHaveBeenCalledWith({ key: "Orders-topic", eventVersionId: "vv-orders-2", kind: "channel", itemKey: "orders-topic" });
  });

  it("forgets the chosen item when the user goes back and picks another version", async () => {
    setup();
    await toItems();
    fireEvent.click(screen.getByTestId("external-ref-item-OrderCreated"));
    fireEvent.click(button("Back"));
    fireEvent.click(within(screen.getByTestId("external-ref-version-vv-orders-1")).getByRole("radio"));
    fireEvent.click(button("Next"));
    await itemRow("OrderCreated");
    expect(button("Add").disabled).toBe(true);
  });
});
