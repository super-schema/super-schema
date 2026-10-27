// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ItemTabs } from "@/features/events/builder/sections/ItemTabs";

// cmdk (the search list) needs these; jsdom has no layout.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

type Item = { key: string; label?: string; subtitle: string; broken: boolean };
const item = (key: string, extra: Partial<Item> = {}): Item => ({ key, subtitle: `payload of ${key}`, broken: false, ...extra });

function setup(items: Item[], extra: Partial<Parameters<typeof ItemTabs>[0]> = {}) {
  const onSelect = vi.fn();
  const onAdd = vi.fn();
  render(
    <ItemTabs
      label="Messages" prefix="message" items={items} activeIndex={0} onSelect={onSelect}
      onAdd={onAdd} addLabel="Add message" addTestId="message-add" {...extra}
    />,
  );
  return { onSelect, onAdd };
}
const tabs = () => within(screen.getByRole("tablist", { name: "Messages" })).getAllByRole("tab");
const many = (n: number) => Array.from({ length: n }, (_, i) => item(`message-${i}`));

describe("ItemTabs: the strip", () => {
  it("renders one tab per item with the test id, label, roles and the active marks the old list had", () => {
    setup([item("OrderCreated"), item("RefundIssued")], { activeIndex: 1 });
    expect(tabs().map((t) => t.getAttribute("data-testid"))).toEqual(["message-row-OrderCreated", "message-row-RefundIssued"]);
    expect(tabs().map((t) => t.textContent)).toEqual(["OrderCreated", "RefundIssued"]);
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs()[1].getAttribute("aria-current")).toBe("true");
    expect(tabs()[0].getAttribute("aria-selected")).toBe("false");
    expect(tabs()[0].hasAttribute("aria-current")).toBe(false);
  });

  it("makes only the active tab a tab stop", () => {
    setup([item("a"), item("b"), item("c")], { activeIndex: 1 });
    expect(tabs().map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("puts the subtitle in the tab's title, not on screen", () => {
    setup([item("OrderCreated", { subtitle: "Order entity" })]);
    expect(tabs()[0].getAttribute("title")).toBe("OrderCreated — Order entity");
    expect(screen.queryByText("Order entity")).toBeNull();
  });

  it("uses the label when the item has one", () => {
    setup([item("k1", { label: "Order created" })]);
    expect(tabs()[0].textContent).toBe("Order created");
    expect(tabs()[0].getAttribute("data-testid")).toBe("message-row-k1");
  });

  it("marks a broken item with a dot and says so to a screen reader", () => {
    setup([item("a", { broken: true }), item("b")]);
    expect(within(tabs()[0]).getByText("has problems")).toBeDefined();
    expect(within(tabs()[1]).queryByText("has problems")).toBeNull();
  });

  it("selects the item whose tab is clicked", () => {
    const { onSelect } = setup([item("a"), item("b")]);
    fireEvent.click(tabs()[1]);
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("moves focus and selection with the arrow keys, Home and End", () => {
    const { onSelect } = setup([item("a"), item("b"), item("c")]);
    tabs()[0].focus();
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs()[1]);
    expect(onSelect).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(tabs()[1], { key: "End" });
    expect(document.activeElement).toBe(tabs()[2]);
    expect(onSelect).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(tabs()[2], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs()[0]);
    expect(onSelect).toHaveBeenLastCalledWith("a");
  });

  it("leaves other keys alone", () => {
    const { onSelect } = setup([item("a"), item("b")]);
    const notPrevented = fireEvent.keyDown(tabs()[0], { key: "Enter" });
    expect(notPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("ItemTabs: broken documents", () => {
  it("shows an item with no key as (no key) and can reach it by keyboard", () => {
    const { onSelect } = setup([item("a"), item("")]);
    expect(tabs()[1].textContent).toBe("(no key)");
    tabs()[0].focus();
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs()[1]);
    expect(onSelect).toHaveBeenLastCalledWith("");
  });

  it("renders two items that share a key, and arrow keys still walk through both", () => {
    setup([item("dup"), item("dup"), item("z")]);
    expect(screen.getAllByTestId("message-row-dup")).toHaveLength(2);
    tabs()[0].focus();
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs()[1]);
    fireEvent.keyDown(tabs()[1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs()[2]);
  });
});

describe("ItemTabs: search by key, focus and remounting", () => {
  it("finds an item by its key even when the tab shows a name or title", async () => {
    const named = Array.from({ length: 10 }, (_, i) => item(`order-created-${i}`, { label: `Order created ${i}` }));
    const { onSelect } = setup(named);
    fireEvent.click(screen.getByTestId("message-tabs-list"));
    const panel = await screen.findByTestId("message-tabs-list-panel");
    fireEvent.change(within(panel).getByRole("combobox"), { target: { value: "order-created-4" } });
    expect(within(panel).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(within(panel).getByRole("option"));
    expect(onSelect).toHaveBeenCalledWith("order-created-4");
  });

  it("shows the key beside the label in the list when they differ, and only the label when they are the same", async () => {
    setup([item("a-key", { label: "A name" }), item("same"), ...many(5)]);
    fireEvent.click(screen.getByTestId("message-tabs-list"));
    const panel = await screen.findByTestId("message-tabs-list-panel");
    const options = within(panel).getAllByRole("option");
    expect(options[0].textContent).toContain("A name");
    expect(options[0].textContent).toContain("a-key");
    expect(options[1].textContent).toBe("same");
  });

  it("keeps the same tab element, and its focus, when the item's key changes (a key named on leaving the form)", () => {
    const onSelect = vi.fn();
    const props = { label: "Messages", prefix: "message", activeIndex: 0, onSelect } as const;
    const { rerender } = render(<ItemTabs {...props} items={[item("message"), item("other")]} />);
    const before = tabs()[0];
    before.focus();
    rerender(<ItemTabs {...props} items={[item("Order-created"), item("other")]} />);
    expect(tabs()[0]).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(tabs()[0].getAttribute("data-testid")).toBe("message-row-Order-created");
  });

  it("moves focus to the active tab when its focusSignal goes up, and not on first render", () => {
    const props = { label: "Messages", prefix: "message", onSelect: vi.fn() } as const;
    const items = [item("a"), item("b"), item("c")];
    const { rerender } = render(<ItemTabs {...props} items={items} activeIndex={1} focusSignal={0} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<ItemTabs {...props} items={items} activeIndex={1} focusSignal={1} />);
    expect(document.activeElement).toBe(tabs()[1]);
    tabs()[1].blur();
    rerender(<ItemTabs {...props} items={items} activeIndex={2} focusSignal={1} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("ItemTabs: the add button", () => {
  it("is outside the tab list and adds", () => {
    const { onAdd } = setup([item("a")]);
    const add = screen.getByTestId("message-add");
    expect(add.getAttribute("aria-label")).toBe("Add message");
    expect(screen.getByRole("tablist", { name: "Messages" }).contains(add)).toBe(false);
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("can be disabled, with the reason in its title", () => {
    const { onAdd } = setup([item("a")], { addDisabled: true, addTitle: "Add a channel first" });
    const add = screen.getByTestId("message-add") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute("title")).toBe("Add a channel first");
    fireEvent.click(add);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("is absent without onAdd", () => {
    setup([item("a")], { onAdd: undefined });
    expect(screen.queryByTestId("message-add")).toBeNull();
  });
});

describe("ItemTabs: the search list for many items", () => {
  it("is absent for six items or fewer", () => {
    setup(many(6));
    expect(screen.queryByTestId("message-tabs-list")).toBeNull();
  });

  it("finds one of 45 items by part of its key and selects it", async () => {
    const { onSelect } = setup(many(45));
    expect(tabs()).toHaveLength(45);
    fireEvent.click(screen.getByTestId("message-tabs-list"));
    const panel = await screen.findByTestId("message-tabs-list-panel");
    expect(within(panel).getAllByRole("option")).toHaveLength(45);
    fireEvent.change(within(panel).getByRole("combobox"), { target: { value: "-4" } });
    const hits = within(panel).getAllByRole("option").map((o) => o.textContent);
    expect(hits).toEqual(["message-4", "message-40", "message-41", "message-42", "message-43", "message-44"]);
    fireEvent.click(within(panel).getByText("message-42"));
    expect(onSelect).toHaveBeenCalledWith("message-42");
  });

  it("says when nothing matches", async () => {
    setup(many(10));
    fireEvent.click(screen.getByTestId("message-tabs-list"));
    const panel = await screen.findByTestId("message-tabs-list-panel");
    fireEvent.change(within(panel).getByRole("combobox"), { target: { value: "zzz" } });
    expect(within(panel).queryAllByRole("option")).toHaveLength(0);
    expect(within(panel).getByText("No match")).toBeDefined();
  });
});
