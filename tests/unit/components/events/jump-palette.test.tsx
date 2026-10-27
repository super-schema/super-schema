// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JumpPalette } from "@/features/events/builder/JumpPalette";
import type { JumpEntry } from "@/features/events/builder/jump";

// cmdk measures its list and scrolls the selected item into view; jsdom has neither.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

const ENTRIES: JumpEntry[] = [
  { section: "messages", item: null, label: "Messages", group: "Sections", problems: 0 },
  { section: "channels", item: null, label: "Channels", group: "Sections", problems: 1 },
  { section: "messages", item: "OrderCreated", label: "OrderCreated", group: "Messages", problems: 0 },
  { section: "messages", item: "RefundIssued", label: "RefundIssued", group: "Messages", problems: 2 },
  { section: "channels", item: "orders", label: "orders", group: "Channels", problems: 0 },
];

function setup(open = true) {
  const onJump = vi.fn();
  const onOpenChange = vi.fn();
  render(<JumpPalette open={open} onOpenChange={onOpenChange} entries={ENTRIES} onJump={onJump} />);
  return { onJump, onOpenChange };
}
const options = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("JumpPalette", () => {
  it("shows nothing while closed", () => {
    setup(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists every entry under its group when it opens", async () => {
    setup();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Sections")).toBeDefined();
    expect(within(dialog).getByText("Messages", { selector: "[cmdk-group-heading]" })).toBeDefined();
    expect(options()).toEqual(["Messages", "Channels", "OrderCreated", "RefundIssued", "orders"]);
  });

  it("filters as the user types", async () => {
    setup();
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "refund" } });
    expect(options()).toEqual(["RefundIssued"]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nothing matches")).toBeDefined();
  });

  it("jumps to the chosen entry and closes", async () => {
    const { onJump, onOpenChange } = setup();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByText("RefundIssued"));
    expect(onJump).toHaveBeenCalledWith(ENTRIES[3]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("marks an entry that has problems, and says so to a screen reader", async () => {
    setup();
    await screen.findByRole("dialog");
    const option = (label: string) => screen.getAllByRole("option").find((o) => o.textContent === label) as HTMLElement;
    expect(option("RefundIssued").getAttribute("aria-label")).toBe("RefundIssued, 2 problems");
    expect(option("Channels").getAttribute("aria-label")).toBe("Channels, 1 problem");
    expect(option("OrderCreated").hasAttribute("aria-label")).toBe(false);
  });

  it("closes on Escape without jumping", async () => {
    const { onJump, onOpenChange } = setup();
    await screen.findByRole("dialog");
    await act(async () => { fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" }); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onJump).not.toHaveBeenCalled();
  });
});
