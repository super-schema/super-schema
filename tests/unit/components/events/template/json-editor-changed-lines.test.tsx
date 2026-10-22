// @vitest-environment jsdom
// JsonEditor's opt-in `changedLines` decoration (the Detail Panel's diff highlight), on the real CodeMirror in jsdom.
import "./codemirror-jsdom";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JsonEditor } from "@/features/events/builder/template/controls/JsonEditor";

afterEach(cleanup);

const TEXT = ["{", '  "a": 1,', '  "b": 2,', '  "c": 3', "}"].join("\n");

function mount(changedLines?: readonly number[]) {
  const props = { id: "ed", value: TEXT, onChange: () => undefined, language: "json" as const, ariaLabel: "x" };
  const utils = render(<JsonEditor {...props} changedLines={changedLines} />);
  return { ...utils, update: (next?: readonly number[]) => utils.rerender(<JsonEditor {...props} changedLines={next} />) };
}
const marked = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".cm-line")).flatMap((el, i) => (el.classList.contains("cm-changed-line") ? [i + 1] : []));
const ready = (container: HTMLElement) => waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());

describe("JsonEditor changedLines", () => {
  it("marks no line without the prop", async () => {
    const { container } = mount();
    await ready(container);
    expect(marked(container)).toEqual([]);
    expect(container.firstElementChild?.getAttribute("data-changed-count")).toBeNull();
  });

  it("decorates the given 1-based lines and follows prop changes without rebuilding the editor", async () => {
    const { container, update } = mount([2, 4]);
    await ready(container);
    await waitFor(() => expect(marked(container)).toEqual([2, 4]));
    const dom = container.querySelector(".cm-editor");
    update([3]);
    await waitFor(() => expect(marked(container)).toEqual([3]));
    expect(container.querySelector(".cm-editor")).toBe(dom);
    update([]);
    await waitFor(() => expect(marked(container)).toEqual([]));
  });

  it("ignores line numbers beyond the document", async () => {
    const { container } = mount([2, 99, 0]);
    await ready(container);
    await waitFor(() => expect(marked(container)).toEqual([2]));
  });

  it("draws a rule where lines were removed, before a line or after the last", async () => {
    const props = { id: "ed", value: TEXT, onChange: () => undefined, language: "json" as const, ariaLabel: "x" };
    const { container } = render(<JsonEditor {...props} changedLines={[]} removedAt={[1, 5]} />);
    await ready(container);
    const lines = () => Array.from(container.querySelectorAll(".cm-line"));
    await waitFor(() => expect(lines()[1].classList.contains("cm-removed-before")).toBe(true));
    expect(lines()[4].classList.contains("cm-removed-after")).toBe(true);
  });

  it("reports the count on the wrapper, also on the textarea fallback", () => {
    const { container } = mount([1, 2, 3]);
    expect(container.firstElementChild?.getAttribute("data-changed-count")).toBe("3");
  });
});
