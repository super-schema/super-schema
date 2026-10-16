// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), createEventAction: vi.fn(), invalidate: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ createEventAction: h.createEventAction }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => h.invalidate }));

import { EventsList } from "@/features/events/workspace/EventsList";
import type { EventListItem } from "@/features/events/event-page/load-events-list";
import { assetHref } from "@/lib/navigation/asset-href";

const at = { domainSlug: "payments", productSlug: "checkout" };
const eventHref = (id: string) => assetHref({ kind: "event", id, ...at });

function item(over: Partial<EventListItem> & { id: string; name: string }): EventListItem {
  return {
    specType: "asyncapi@3.0", versionLabel: null, hasUnpublishedChanges: true,
    channels: 0, messages: 0, operations: 0, href: eventHref(over.id), ...over,
  };
}

const ORDERS = item({ id: "ev1", name: "orders", versionLabel: "1.2", hasUnpublishedChanges: true, channels: 2, messages: 3, operations: 1 });
const PAYMENTS = item({ id: "ev2", name: "payments", versionLabel: "2.0", hasUnpublishedChanges: false, channels: 1, messages: 1, operations: 2 });
const DRAFT_ONLY = item({ id: "ev3", name: "refunds", versionLabel: null, hasUnpublishedChanges: true });

function renderList(props: Partial<Parameters<typeof EventsList>[0]> = {}) {
  return render(<EventsList productId="p1" {...at} items={[ORDERS, PAYMENTS, DRAFT_ONLY]} {...props} />);
}
const row = (id: string) => screen.getByTestId(`event-row-${id}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.createEventAction.mockResolvedValue({ success: true, data: { id: "ev9" } });
});
afterEach(() => cleanup());

describe("EventsList: rows", () => {
  it("is the events tab container, with one labelled list entry per event in the given order", () => {
    renderList();
    expect(screen.getByTestId("events-tab")).toBeDefined();
    const list = screen.getByRole("list", { name: "Events" });
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-testid"))).toEqual(["event-row-ev1", "event-row-ev2", "event-row-ev3"]);
  });

  it("links the name to the event page through item.href", () => {
    renderList();
    expect(within(row("ev1")).getByRole("link", { name: "orders" }).getAttribute("href")).toBe("/schemas/payments/checkout/events/ev1");
    expect(within(row("ev2")).getByRole("link", { name: "payments" }).getAttribute("href")).toBe(eventHref("ev2"));
  });

  it("uses the href the loader gave, whatever it is", () => {
    renderList({ items: [item({ id: "ev1", name: "orders", href: "/somewhere/else" })] });
    expect(screen.getByRole("link", { name: "orders" }).getAttribute("href")).toBe("/somewhere/else");
  });

  it("shows the AsyncAPI 3.0 badge for the asyncapi@3.0 spec type", () => {
    renderList();
    for (const id of ["ev1", "ev2", "ev3"]) expect(within(row(id)).getByTestId(`event-row-${id}-spec`).textContent).toBe("AsyncAPI 3.0");
  });

  it("shows a spec type it has no label for as stored", () => {
    renderList({ items: [item({ id: "ev1", name: "orders", specType: "openapi@3.1" })] });
    expect(within(row("ev1")).getByTestId("event-row-ev1-spec").textContent).toBe("openapi@3.1");
  });

  it("shows the latest version label, or Unpublished for a never-published event", () => {
    renderList();
    expect(within(row("ev1")).getByTestId("event-row-ev1-version").textContent).toBe("v1.2");
    expect(within(row("ev2")).getByTestId("event-row-ev2-version").textContent).toBe("v2.0");
    expect(within(row("ev3")).getByTestId("event-row-ev3-version").textContent).toBe("Unpublished");
  });

  it("shows the Draft badge exactly for events with unpublished changes", () => {
    renderList();
    expect(within(row("ev1")).getByTestId("event-row-ev1-draft").textContent).toBe("Draft");
    expect(within(row("ev3")).getByTestId("event-row-ev3-draft").textContent).toBe("Draft");
    expect(within(row("ev2")).queryByTestId("event-row-ev2-draft")).toBeNull();
  });

  it("shows the channel, message and operation counts, singular where it is one", () => {
    renderList();
    expect(within(row("ev1")).getByTestId("event-row-ev1-counts").textContent).toBe("2 channels · 3 messages · 1 operation");
    expect(within(row("ev2")).getByTestId("event-row-ev2-counts").textContent).toBe("1 channel · 1 message · 2 operations");
    expect(within(row("ev3")).getByTestId("event-row-ev3-counts").textContent).toBe("0 channels · 0 messages · 0 operations");
  });

  it("does not show the empty state or open a dialog when there are events", () => {
    renderList();
    expect(screen.queryByTestId("events-empty")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("EventsList: empty state", () => {
  it("says there are no events yet and offers the primary New Event button", () => {
    renderList({ items: [] });
    const empty = screen.getByTestId("events-empty");
    expect(within(empty).getByRole("heading", { name: "No events yet" })).toBeDefined();
    expect(within(empty).getByRole("button", { name: "New Event" })).toBe(screen.getByTestId("events-empty-create"));
    expect(screen.queryByRole("list", { name: "Events" })).toBeNull();
  });

  it("keeps the events-tab container so the tab panel is always findable", () => {
    renderList({ items: [] });
    expect(screen.getByTestId("events-tab")).toBeDefined();
  });

  it("calls onCreate from the empty-state button, and opens no dialog of its own", () => {
    const onCreate = vi.fn();
    renderList({ items: [], onCreate });
    fireEvent.click(screen.getByTestId("events-empty-create"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("EventsList: create", () => {
  it("offers a New Event button above a non-empty list that calls onCreate", () => {
    const onCreate = vi.fn();
    renderList({ onCreate });
    fireEvent.click(screen.getByTestId("events-new"));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("without onCreate it opens its own New Event dialog for the product and opens the created event", async () => {
    renderList({ items: [] });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("events-empty-create"));
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.change(screen.getByTestId("new-event-name"), { target: { value: "order-events" } });
    fireEvent.click(screen.getByTestId("new-event-submit"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout/events/ev9"));
    expect(h.createEventAction).toHaveBeenCalledWith("p1", { name: "order-events", description: undefined });
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it("without onCreate the toolbar button opens the same dialog, and Cancel closes it", async () => {
    renderList();
    fireEvent.click(screen.getByTestId("events-new"));
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.click(screen.getByTestId("new-event-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.createEventAction).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
});
