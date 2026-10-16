// @vitest-environment jsdom
// JsonControl through the REAL CodeMirror editor (jsdom with the stand-ins of ./codemirror-jsdom): the same contract as the textarea.
import "./codemirror-jsdom";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { field, renderField, type HarnessOptions } from "./harness";

afterEach(cleanup);

const JSON_FIELD = field("json", { label: "Headers" });

/** Render and wait for CodeMirror to take over from the textarea. */
async function mount(options: HarnessOptions = {}, f = JSON_FIELD) {
  const rendered = renderField(f, options);
  await waitFor(() => expect(rendered.container.querySelector(".cm-editor")).not.toBeNull());
  const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor") as HTMLElement) as EditorView;
  return { ...rendered, view };
}
/** Replace the whole text the way a paste would. */
const write = (view: EditorView, text: string) => act(() => {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.paste" });
});
const content = () => document.querySelector(".cm-content") as HTMLElement;

describe("JsonControl with CodeMirror", () => {
  it("shows the value as pretty JSON in the editor, named like the field", async () => {
    const { view, container } = await mount({ value: { thing: { traceId: "abc", n: [1, 2] } } });
    expect(view.state.doc.toString()).toBe(JSON.stringify({ traceId: "abc", n: [1, 2] }, null, 2));
    expect(container.querySelector('[data-testid="f-thing-editor"]')?.getAttribute("data-editor")).toBe("codemirror");
    expect(screen.getByLabelText("Headers")).toBe(content());
    expect(content().id).toBe("f-thing");
  });

  it("writes the parsed value once the text is valid JSON", async () => {
    const { view, probe } = await mount();
    write(view, '{ "orderId": "o-1", "lines": [1, 2] }');
    expect(probe.value).toEqual({ thing: { orderId: "o-1", lines: [1, 2] } });
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
    expect(content().hasAttribute("aria-invalid")).toBe(false);
  });

  it("accepts any JSON value", async () => {
    const { view, probe } = await mount();
    write(view, '"just text"');
    expect(probe.value).toEqual({ thing: "just text" });
    write(view, "42");
    expect(probe.value).toEqual({ thing: 42 });
    write(view, "[1,2]");
    expect(probe.value).toEqual({ thing: [1, 2] });
  });

  it("keeps invalid text in the editor, shows the error under it and writes nothing", async () => {
    const { view, probe } = await mount({ value: { thing: { a: 1 } } });
    write(view, '{ "a": ');
    expect(view.state.doc.toString()).toBe('{ "a": ');
    expect(screen.getByTestId("f-thing-validation").textContent).toMatch(/^Not valid JSON: /);
    expect(content().getAttribute("aria-invalid")).toBe("true");
    expect(content().getAttribute("aria-describedby")).toContain("f-thing-validation");
    expect(probe.onChange).not.toHaveBeenCalled();
    expect(probe.value).toEqual({ thing: { a: 1 } });
  });

  it("writes again, and drops the error, as soon as the text becomes valid", async () => {
    const { view, probe } = await mount();
    write(view, "{ oops");
    expect(screen.getByTestId("f-thing-validation")).toBeTruthy();
    write(view, '{ "fixed": true }');
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
    expect(probe.value).toEqual({ thing: { fixed: true } });
    expect(view.state.doc.toString()).toBe('{ "fixed": true }');
    expect(content().hasAttribute("aria-invalid")).toBe(false);
  });

  it("removes the key when the text is cleared, with no error", async () => {
    const { view, probe } = await mount({ value: { thing: { a: 1 } } });
    write(view, "");
    expect(probe.value).toEqual({});
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
  });

  it("does not reformat the text the user typed", async () => {
    const { view } = await mount();
    write(view, '{"a":   1}');
    expect(view.state.doc.toString()).toBe('{"a":   1}');
  });

  it("keeps what is typed while the value is unchanged, and follows a change from outside", async () => {
    const { view, probe } = await mount({ value: { thing: { a: 1 } } });
    write(view, '{"a":1}');
    act(() => { view.dispatch({ selection: { anchor: 2 } }); });
    probe.set({ thing: { a: 1 } });
    expect(view.state.doc.toString()).toBe('{"a":1}');
    expect(view.state.selection.main.head).toBe(2);
    probe.set({ thing: { a: 2 } });
    expect(view.state.doc.toString()).toBe(JSON.stringify({ a: 2 }, null, 2));
  });

  it("is not editable when the form is disabled", async () => {
    const { view } = await mount({ disabled: true, value: { thing: { a: 1 } } });
    expect(view.state.readOnly).toBe(true);
    expect(content().getAttribute("contenteditable")).toBe("false");
  });

  it("shows the form's required mark, help text and error to assistive technology", async () => {
    await mount(
      { errors: [{ pointer: "/thing", message: "Must be an object" }] },
      field("json", { required: true, help: "A JSON object." }),
    );
    expect(content().getAttribute("aria-required")).toBe("true");
    expect(content().getAttribute("aria-invalid")).toBe("true");
    expect(content().getAttribute("aria-describedby")).toContain("f-thing-error f-thing-hint");
  });
});
