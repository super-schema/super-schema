// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PaneRail, usePaneState, type PaneDef } from "@/features/events/builder/sections/PaneRail";

afterEach(cleanup);

describe("usePaneState", () => {
  it("starts on the default pane", () => {
    const { result } = renderHook(() => usePaneState("payload", new Set<string>()));
    expect(result.current.active).toBe("payload");
  });

  it("goes to the pane the user selects", () => {
    const { result } = renderHook(() => usePaneState("payload", new Set<string>()));
    act(() => result.current.select("examples"));
    expect(result.current.active).toBe("examples");
  });

  it("goes to a pane that newly holds a problem, once", () => {
    const { result, rerender } = renderHook(({ errored }) => usePaneState("payload", errored), { initialProps: { errored: new Set<string>() } });
    rerender({ errored: new Set(["bindings"]) });
    expect(result.current.active).toBe("bindings");
    act(() => result.current.select("details"));
    // the same problem still stands: the user's choice is kept
    rerender({ errored: new Set(["bindings"]) });
    expect(result.current.active).toBe("details");
  });

  it("goes back to a pane whose problem went away and then came back", () => {
    const { result, rerender } = renderHook(({ errored }) => usePaneState("payload", errored), { initialProps: { errored: new Set(["bindings"]) } });
    act(() => result.current.select("details"));
    rerender({ errored: new Set<string>() });
    expect(result.current.active).toBe("details");
    rerender({ errored: new Set(["bindings"]) });
    expect(result.current.active).toBe("bindings");
  });

  it("goes to a pane that holds a problem from the first render", () => {
    const { result } = renderHook(() => usePaneState("payload", new Set(["docs"])));
    expect(result.current.active).toBe("docs");
  });

  it("goes to the first of several new problems, in the order the set lists them", () => {
    const { result, rerender } = renderHook(({ errored }) => usePaneState("payload", errored), { initialProps: { errored: new Set<string>() } });
    rerender({ errored: new Set(["details", "bindings"]) });
    expect(result.current.active).toBe("details");
  });

  it("goes to a second problem that shows up later, and not back to one the user left", () => {
    const { result, rerender } = renderHook(({ errored }) => usePaneState("payload", errored), { initialProps: { errored: new Set(["details"]) } });
    expect(result.current.active).toBe("details");
    act(() => result.current.select("payload"));
    rerender({ errored: new Set(["details", "examples"]) });
    expect(result.current.active).toBe("examples");
  });
});

const PANES: PaneDef[] = [
  { id: "payload", title: "Payload", body: <p>payload body</p> },
  { id: "details", title: "Details", count: 3, body: <p>details body</p> },
  { id: "examples", title: "Examples", count: 0, broken: true, body: <p>examples body</p> },
  { id: "more", title: "More", body: <p>more body</p> },
];

function Rail({ keepMounted = [] as string[], start = "payload" }: { keepMounted?: string[]; start?: string }) {
  const [active, setActive] = useState(start);
  return <PaneRail idPrefix="x-card" panes={PANES} active={active} onSelect={setActive} keepMounted={keepMounted} />;
}
const tab = (id: string) => screen.getByTestId(`x-card-${id}-toggle`);

describe("PaneRail", () => {
  it("renders a vertical tab list with one tab per pane, wired to a tab panel", () => {
    render(<Rail />);
    const list = screen.getByRole("tablist");
    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    expect(within(list).getAllByRole("tab").map((t) => t.getAttribute("data-testid"))).toEqual([
      "x-card-payload-toggle", "x-card-details-toggle", "x-card-examples-toggle", "x-card-more-toggle",
    ]);
    expect(tab("payload").getAttribute("aria-selected")).toBe("true");
    expect(tab("details").getAttribute("aria-selected")).toBe("false");
    const panel = screen.getByTestId("x-card-payload-body");
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(tab("payload").getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("payload").id);
  });

  it("makes only the active tab a tab stop", () => {
    render(<Rail />);
    expect(["payload", "details", "examples", "more"].map((id) => tab(id).getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
  });

  it("renders only the body of a pane the user has not visited (and the ones it is told to keep)", () => {
    render(<Rail keepMounted={["details"]} />);
    expect(screen.getByText("payload body")).toBeDefined();
    expect(screen.getByTestId("x-card-details-body")).toBeDefined();
    expect(screen.queryByTestId("x-card-more-body")).toBeNull();
  });

  it("builds a pane that holds a problem even though it was never shown, hidden, so its error is in the page", () => {
    render(<Rail />);
    const body = screen.getByTestId("x-card-examples-body");
    expect(body.hasAttribute("hidden")).toBe(true);
    expect(within(body).getByText("examples body")).toBeDefined();
  });

  it("shows the selected pane, hides the one left, and keeps what the left pane held", () => {
    render(<Rail />);
    fireEvent.click(tab("examples"));
    expect(screen.getByTestId("x-card-examples-body").hasAttribute("hidden")).toBe(false);
    const left = screen.getByTestId("x-card-payload-body");
    expect(left.hasAttribute("hidden")).toBe(true);
    expect(within(left).getByText("payload body")).toBeDefined();
    fireEvent.click(tab("payload"));
    expect(screen.getByTestId("x-card-payload-body").hasAttribute("hidden")).toBe(false);
    expect(screen.getByTestId("x-card-examples-body").hasAttribute("hidden")).toBe(true);
  });

  it("shows a count only when it is more than zero, with the number said to a screen reader", () => {
    render(<Rail />);
    expect(screen.getByTestId("x-card-details-count").textContent).toBe("3");
    expect(tab("details").textContent).toContain("3 set");
    expect(screen.queryByTestId("x-card-examples-count")).toBeNull();
    expect(screen.queryByTestId("x-card-payload-count")).toBeNull();
  });

  it("marks a pane that holds a problem", () => {
    render(<Rail />);
    expect(within(tab("examples")).getByText("has problems")).toBeDefined();
    expect(within(tab("details")).queryByText("has problems")).toBeNull();
  });

  it("moves with the arrow keys of either orientation, Home and End", () => {
    render(<Rail />);
    tab("payload").focus();
    fireEvent.keyDown(tab("payload"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(tab("details"));
    expect(tab("details").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("details"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("examples"));
    fireEvent.keyDown(tab("examples"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(tab("details"));
    fireEvent.keyDown(tab("details"), { key: "End" });
    expect(document.activeElement).toBe(tab("more"));
    fireEvent.keyDown(tab("more"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(tab("payload"));
    fireEvent.keyDown(tab("payload"), { key: "Home" });
    expect(tab("payload").getAttribute("aria-selected")).toBe("true");
  });

  it("lets a long title wrap inside the rail instead of running into the pane, and keeps it on one line in the pills", () => {
    render(<Rail />);
    const title = screen.getByText("Details");
    expect(title.className).toContain("whitespace-nowrap");
    expect(title.className).toContain("@xl:whitespace-normal");
  });

  it("lays out as pills below a container width and as a rail above it", () => {
    render(<Rail />);
    const wrapper = screen.getByTestId("x-card-rail");
    expect(wrapper.className).toContain("@container");
    expect(screen.getByRole("tablist").className).toContain("@xl:flex-col");
  });
});
