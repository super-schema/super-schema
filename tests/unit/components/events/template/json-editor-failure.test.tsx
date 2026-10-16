// @vitest-environment jsdom
// When CodeMirror cannot be loaded or started, the editor stays a working textarea, and a later editor tries again.
import "./codemirror-jsdom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ loads: 0, failLoads: 0, failCreate: 0 }));
vi.mock("@/features/events/builder/template/controls/codemirror-setup", async (importOriginal) => {
  h.loads++;
  if (h.failLoads > 0) {
    h.failLoads--;
    throw new Error("Loading chunk failed");
  }
  const actual = await importOriginal<typeof import("@/features/events/builder/template/controls/codemirror-setup")>();
  return {
    ...actual,
    createEditor: (args: Parameters<typeof actual.createEditor>[0]) => {
      if (h.failCreate > 0) {
        h.failCreate--;
        throw new Error("EditorView failed");
      }
      return actual.createEditor(args);
    },
  };
});

import { JsonEditor } from "@/features/events/builder/template/controls/JsonEditor";

afterEach(() => {
  cleanup();
  Object.assign(h, { failLoads: 0, failCreate: 0 });
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
function mount() {
  const onChange = vi.fn();
  const utils = render(<JsonEditor id="ed" value="[1]" onChange={onChange} language="json" ariaLabel="Payload" />);
  return { ...utils, onChange };
}

describe("JsonEditor: when CodeMirror fails", () => {
  it("keeps a working textarea when the code cannot be loaded, then tries again for the next editor", async () => {
    h.failLoads = 1;
    const first = mount();
    await settle();
    expect(h.loads).toBe(1);
    expect(first.container.querySelector(".cm-editor")).toBeNull();
    const area = screen.getByTestId("ed") as HTMLTextAreaElement;
    expect(area.tagName).toBe("TEXTAREA");
    fireEvent.change(area, { target: { value: "[2]" } });
    expect(first.onChange).toHaveBeenCalledWith("[2]");
    first.unmount();

    const second = mount();
    await waitFor(() => expect(second.container.querySelector(".cm-editor")).not.toBeNull());
    expect(h.loads).toBe(2);
  });

  it("keeps the textarea when the editor cannot be built", async () => {
    h.failCreate = 1;
    const { container } = mount();
    await settle();
    expect(container.querySelector(".cm-editor")).toBeNull();
    expect(container.firstElementChild?.getAttribute("data-editor")).toBe("textarea");
    expect((screen.getByTestId("ed") as HTMLTextAreaElement).value).toBe("[1]");
  });
});
