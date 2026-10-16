// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LibraryTraitOption } from "@/features/events/builder/EventBuilder";
import { PropertiesChooser, type PropertiesChooserProps } from "@/features/events/builder/sections/PropertiesChooser";
import { BUNDLED_TRAITS, propertySummary } from "@/lib/events/bundled-traits";

// cmdk measures its list and scrolls the selected item into view; jsdom has neither.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

const cloudEvents = BUNDLED_TRAITS.find((t) => t.name === "CloudEvents")!;
const traceContext = BUNDLED_TRAITS.find((t) => t.name === "TraceContext")!;

const LIBRARY: LibraryTraitOption[] = [
  { id: "b-ce", name: "CloudEvents 1.0", kind: "MESSAGE", bundled: true, level: "Enterprise", spec: cloudEvents.spec, properties: propertySummary(cloudEvents.spec) },
  { id: "b-tc", name: "W3C Trace Context", kind: "MESSAGE", bundled: true, level: "Enterprise", spec: traceContext.spec, properties: propertySummary(traceContext.spec) },
  { id: "l-audit", name: "Audit headers", kind: "MESSAGE", level: "Domain · Payments", properties: [{ name: "actor", type: "string", required: true }] },
  { id: "l-plain", name: "Plain message set", kind: "MESSAGE" },
  { id: "l-retry", name: "Retry policy", kind: "OPERATION", level: "Enterprise" },
  { id: "l-dead", name: "Dead letter", kind: "OPERATION" },
];

function setup(props: Partial<PropertiesChooserProps> = {}) {
  const onChoose = vi.fn();
  render(<PropertiesChooser library={LIBRARY} onChoose={onChoose} triggerTestId="open" {...props} />);
  return { onChoose };
}
const open = async () => {
  fireEvent.click(screen.getByTestId("open"));
  return screen.findByTestId("trait-chooser");
};
const items = (group: string) => within(screen.getByTestId(group)).getAllByRole("option").map((o) => o.textContent);

describe("PropertiesChooser: the single + Add", () => {
  it("is one button that says Add, named for its kind, and shows nothing until it is opened", () => {
    setup();
    expect(screen.getByTestId("open").textContent).toContain("Add");
    expect(screen.getByTestId("open").getAttribute("aria-label")).toBe("Add message properties");
    expect(screen.queryByTestId("trait-chooser")).toBeNull();
  });

  it("names the trigger for the operation kind when it is locked to operations, or by an explicit label", () => {
    setup({ kind: "OPERATION" });
    expect(screen.getByTestId("open").getAttribute("aria-label")).toBe("Add operation properties");
    cleanup();
    setup({ triggerLabel: "Add something" });
    expect(screen.getByTestId("open").getAttribute("aria-label")).toBe("Add something");
  });

  it("opens a popover with a segmented Applies to, a search box and the three groups", async () => {
    setup();
    await open();
    const kind = screen.getByTestId("trait-chooser-kind");
    expect(kind.getAttribute("role")).toBe("radiogroup");
    expect(within(kind).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Message", "Operation"]);
    expect(screen.getByTestId("trait-chooser-kind-message").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("trait-chooser-kind-operation").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("trait-chooser-search")).toBeDefined();
    expect(within(screen.getByTestId("trait-chooser-group-builtin")).getByText("Built in")).toBeDefined();
    expect(within(screen.getByTestId("trait-chooser-group-library")).getByText("Library")).toBeDefined();
    expect(within(screen.getByTestId("trait-chooser-group-new")).getByText("New (blank)")).toBeDefined();
  });

  it("focuses the search box when it opens", async () => {
    setup();
    await open();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("trait-chooser-search")));
  });
});

describe("PropertiesChooser: groups and counts", () => {
  it("lists the built-in sets with their property count, the other library sets of the kind, and the blank item", async () => {
    setup();
    await open();
    expect(items("trait-chooser-group-builtin")).toEqual([
      "CloudEvents 1.0 — 8 propertiesEnterprise",
      "W3C Trace Context — 2 propertiesEnterprise",
    ]);
    expect(items("trait-chooser-group-library")).toEqual(["Audit headers — 1 propertyDomain · Payments", "Plain message set"]);
    expect(items("trait-chooser-group-new")).toEqual(["New message propertiesTrait"]);
  });

  it("shows the real count of the built-in CloudEvents set", async () => {
    setup();
    await open();
    expect(screen.getByTestId("trait-chooser-item-b-ce").textContent).toContain("CloudEvents 1.0 — 8 properties");
  });

  it("counts from the spec's inline headers when the option carries no summary", async () => {
    setup({ library: [{ id: "x", name: "From spec", kind: "MESSAGE", spec: { headers: { type: "object", properties: { a: {}, b: {}, c: {} } } } }] });
    await open();
    expect(screen.getByTestId("trait-chooser-item-x").textContent).toContain("From spec — 3 properties");
  });

  it("omits the group of built-in sets when there are none of that kind", async () => {
    setup({ library: LIBRARY.filter((l) => !l.bundled) });
    await open();
    expect(screen.queryByTestId("trait-chooser-group-builtin")).toBeNull();
    expect(screen.getByTestId("trait-chooser-group-library")).toBeDefined();
  });

  it("always offers the blank item, even with an empty library", async () => {
    setup({ library: [] });
    await open();
    expect(screen.queryByTestId("trait-chooser-group-builtin")).toBeNull();
    expect(screen.queryByTestId("trait-chooser-group-library")).toBeNull();
    expect(screen.getByTestId("trait-chooser-item-new")).toBeDefined();
  });
});

describe("PropertiesChooser: Applies to", () => {
  it("switches to operations: only operation sets, no built-in group, a blank operation item, and no property counts", async () => {
    setup();
    await open();
    fireEvent.click(screen.getByTestId("trait-chooser-kind-operation"));
    expect(screen.getByTestId("trait-chooser-kind-operation").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("trait-chooser-group-builtin")).toBeNull();
    expect(items("trait-chooser-group-library")).toEqual(["Retry policyEnterprise", "Dead letter"]);
    expect(items("trait-chooser-group-new")).toEqual(["New operation propertiesTrait"]);
    expect(screen.queryByTestId("trait-chooser-item-l-audit")).toBeNull();
  });

  it("starts on the kind it is told to, every time it opens", async () => {
    setup({ defaultKind: "OPERATION" });
    await open();
    expect(screen.getByTestId("trait-chooser-kind-operation").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("trait-chooser-item-l-retry")).toBeDefined();
    fireEvent.click(screen.getByTestId("trait-chooser-kind-message"));
    fireEvent.keyDown(screen.getByTestId("trait-chooser-search"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("trait-chooser")).toBeNull());
    await open();
    expect(screen.getByTestId("trait-chooser-kind-operation").getAttribute("aria-checked")).toBe("true");
  });

  it("is locked to one kind when opened from a message: no segmented control, only that kind", async () => {
    setup({ kind: "MESSAGE" });
    await open();
    expect(screen.queryByTestId("trait-chooser-kind")).toBeNull();
    expect(screen.getByTestId("trait-chooser-kind-locked").textContent).toContain("this message");
    expect(screen.queryByTestId("trait-chooser-item-l-retry")).toBeNull();
    expect(screen.getByTestId("trait-chooser-item-b-ce")).toBeDefined();
  });

  it("says this operation when locked to operations", async () => {
    setup({ kind: "OPERATION" });
    await open();
    expect(screen.getByTestId("trait-chooser-kind-locked").textContent).toContain("this operation");
    expect(screen.getByTestId("trait-chooser-item-l-retry")).toBeDefined();
  });
});

describe("PropertiesChooser: search", () => {
  it("filters every group by the typed words", async () => {
    setup();
    await open();
    fireEvent.change(screen.getByTestId("trait-chooser-search"), { target: { value: "cloud" } });
    expect(items("trait-chooser-group-builtin")).toEqual(["CloudEvents 1.0 — 8 propertiesEnterprise"]);
    expect(screen.queryByTestId("trait-chooser-group-library")).toBeNull();
    expect(screen.queryByTestId("trait-chooser-group-new")).toBeNull();
  });

  it("matches the level too, case-insensitively, and requires every word", async () => {
    setup();
    await open();
    fireEvent.change(screen.getByTestId("trait-chooser-search"), { target: { value: "PAYMENTS audit" } });
    expect(items("trait-chooser-group-library")).toEqual(["Audit headers — 1 propertyDomain · Payments"]);
    fireEvent.change(screen.getByTestId("trait-chooser-search"), { target: { value: "payments cloud" } });
    expect(screen.queryByTestId("trait-chooser-item-b-ce")).toBeNull();
  });

  it("says nothing matches, and still offers the blank item when the search could mean it", async () => {
    setup();
    await open();
    fireEvent.change(screen.getByTestId("trait-chooser-search"), { target: { value: "zzz" } });
    expect(screen.getByTestId("trait-chooser-empty").textContent).toContain("zzz");
    fireEvent.change(screen.getByTestId("trait-chooser-search"), { target: { value: "blank" } });
    expect(screen.getByTestId("trait-chooser-item-new")).toBeDefined();
  });

  it("clears the search each time it opens", async () => {
    setup();
    await open();
    fireEvent.change(screen.getByTestId("trait-chooser-search"), { target: { value: "cloud" } });
    fireEvent.keyDown(screen.getByTestId("trait-chooser-search"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("trait-chooser")).toBeNull());
    await open();
    expect((screen.getByTestId("trait-chooser-search") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("trait-chooser-item-l-audit")).toBeDefined();
  });
});

describe("PropertiesChooser: choosing", () => {
  it("adds a built-in set with one click: hands over the option and closes", async () => {
    const { onChoose } = setup();
    await open();
    fireEvent.click(screen.getByTestId("trait-chooser-item-b-ce"));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith({ type: "library", option: LIBRARY[0] });
    await waitFor(() => expect(screen.queryByTestId("trait-chooser")).toBeNull());
  });

  it("adds a library set with one click", async () => {
    const { onChoose } = setup();
    await open();
    fireEvent.click(screen.getByTestId("trait-chooser-item-l-audit"));
    expect(onChoose).toHaveBeenCalledWith({ type: "library", option: LIBRARY[2] });
  });

  it("adds a blank set of the kind chosen in the segmented control", async () => {
    const { onChoose } = setup();
    await open();
    fireEvent.click(screen.getByTestId("trait-chooser-item-new"));
    expect(onChoose).toHaveBeenLastCalledWith({ type: "blank", kind: "MESSAGE" });
    await open();
    fireEvent.click(screen.getByTestId("trait-chooser-kind-operation"));
    fireEvent.click(screen.getByTestId("trait-chooser-item-new"));
    expect(onChoose).toHaveBeenLastCalledWith({ type: "blank", kind: "OPERATION" });
  });

  it("adds an operation library set when the operation kind is chosen", async () => {
    const { onChoose } = setup();
    await open();
    fireEvent.click(screen.getByTestId("trait-chooser-kind-operation"));
    fireEvent.click(screen.getByTestId("trait-chooser-item-l-dead"));
    expect(onChoose).toHaveBeenCalledWith({ type: "library", option: LIBRARY[5] });
  });

  it("chooses with the keyboard: arrow to an item, Enter", async () => {
    const { onChoose } = setup();
    await open();
    const search = screen.getByTestId("trait-chooser-search");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose.mock.calls[0][0]).toMatchObject({ type: "library" });
  });

  it("marks a set already applied as Added and does not choose it again", async () => {
    const { onChoose } = setup({ disabledIds: ["b-ce"] });
    await open();
    expect(screen.getByTestId("trait-chooser-item-b-ce-state").textContent).toBe("Added");
    fireEvent.click(screen.getByTestId("trait-chooser-item-b-ce"));
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("marks a set the event already has an entry for, and still lets it be chosen (the entry is reused)", async () => {
    const { onChoose } = setup({ usedIds: ["l-audit"] });
    await open();
    expect(screen.getByTestId("trait-chooser-item-l-audit-state").textContent).toBe("In this event");
    fireEvent.click(screen.getByTestId("trait-chooser-item-l-audit"));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});
