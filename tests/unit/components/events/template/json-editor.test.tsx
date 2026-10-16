// @vitest-environment jsdom
// JsonEditor with the REAL CodeMirror, running in jsdom on the stand-ins of `./codemirror-jsdom`.
import "./codemirror-jsdom";
import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deleteCharBackward, insertNewlineAndIndent, undo } from "@codemirror/commands";
import { diagnosticCount, forceLinting } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ created: 0 }));
vi.mock("@/features/events/builder/template/controls/codemirror-setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/events/builder/template/controls/codemirror-setup")>();
  return { ...actual, createEditor: (args: Parameters<typeof actual.createEditor>[0]) => { h.created++; return actual.createEditor(args); } };
});

import { JsonEditor, codeMirrorSupported, type JsonEditorProps } from "@/features/events/builder/template/controls/JsonEditor";

afterEach(() => {
  cleanup();
  h.created = 0;
  vi.restoreAllMocks();
});

function mount(over: Partial<JsonEditorProps> = {}) {
  const onChange = vi.fn();
  const props: JsonEditorProps = { id: "ed", value: '{"a": 1}', onChange, language: "json", ariaLabel: "Example payload", ...over };
  const utils = render(<JsonEditor {...props} />);
  return { ...utils, onChange, props, update: (next: Partial<JsonEditorProps>) => utils.rerender(<JsonEditor {...props} {...next} />) };
}

/** Mount and wait until CodeMirror replaced the textarea. */
async function mountEditor(over: Partial<JsonEditorProps> = {}) {
  const mounted = mount(over);
  await waitFor(() => expect(mounted.container.querySelector(".cm-editor")).not.toBeNull());
  return { ...mounted, view: viewOf(mounted.container) };
}

const viewOf = (container: HTMLElement) => {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  return EditorView.findFromDOM(dom) as EditorView;
};
/** A parent that keeps what was typed as the value, like JsonControl does. */
function Holder({ initial = '{"a": 1}', onErrorChange }: { initial?: string; onErrorChange?: (message: string | null) => void }) {
  const [text, setText] = useState(initial);
  return <JsonEditor id="ed" value={text} onChange={setText} language="json" ariaLabel="x" onErrorChange={onErrorChange} />;
}
const root = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const typed = (view: EditorView, insert: string, at = view.state.doc.length) => act(() => { view.dispatch({ changes: { from: at, insert }, userEvent: "input.type" }); });

describe("JsonEditor: loading CodeMirror", () => {
  it("can run here once the stand-ins are installed", () => {
    expect(codeMirrorSupported()).toBe(true);
  });

  it("starts as the textarea and swaps to CodeMirror once it has loaded", async () => {
    const { container } = mount();
    expect(screen.getByTestId("ed").tagName).toBe("TEXTAREA");
    expect(root(container).getAttribute("data-editor")).toBe("textarea");
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    expect(root(container).getAttribute("data-editor")).toBe("codemirror");
    expect(container.querySelector("textarea")).toBeNull();
    expect(screen.getByTestId("ed").classList.contains("cm-editor") || screen.getByTestId("ed").contains(container.querySelector(".cm-editor"))).toBe(true);
  });

  it("builds the editor once, on the text as it is when CodeMirror arrives", async () => {
    const { container, update } = mount({ value: "[1]" });
    update({ value: "[1, 2, 3]" });
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    expect(h.created).toBe(1);
    expect(viewOf(container).state.doc.toString()).toBe("[1, 2, 3]");
  });

  it("shows the document with line numbers and the syntax highlighted", async () => {
    const { container } = await mountEditor({ value: '{\n  "name": "x",\n  "n": 3\n}' });
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(container.querySelectorAll(".cm-line")).toHaveLength(4);
    expect(container.querySelector(".cm-content")?.textContent).toBe('{  "name": "x",  "n": 3}');
    // highlighted tokens are wrapped in classed spans
    expect(container.querySelectorAll(".cm-line span").length).toBeGreaterThan(3);
  });

  it("highlights YAML too", async () => {
    const { container, view } = await mountEditor({ value: "title: Orders\nitems:\n  - 1\n", language: "yaml" });
    expect(view.state.doc.lines).toBe(4);
    expect(container.querySelectorAll(".cm-line span").length).toBeGreaterThan(2);
  });

  it("hands the keyboard over: a user who was typing in the textarea carries on in the editor, at the same place", async () => {
    const { container } = mount({ value: "hello world" });
    const area = screen.getByTestId("ed") as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(2, 5);
    expect(document.activeElement).toBe(area);
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    const view = viewOf(container);
    await waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(5);
  });

  it("does not steal focus when the user was not in the textarea", async () => {
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("goes back to nothing, destroying the editor, when it unmounts", async () => {
    const destroy = vi.spyOn(EditorView.prototype, "destroy");
    const { container, unmount } = await mountEditor();
    const dom = container.querySelector(".cm-editor") as HTMLElement;
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(dom.isConnected).toBe(false);
  });

  it("builds no editor at all when it unmounts before CodeMirror has loaded", async () => {
    const { unmount } = mount();
    unmount();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(h.created).toBe(0);
  });

  it("works again when the host remounts: a new editor, the old one destroyed", async () => {
    const destroy = vi.spyOn(EditorView.prototype, "destroy");
    const first = await mountEditor({ value: '{"first": true}' });
    first.unmount();
    expect(destroy).toHaveBeenCalledTimes(1);

    const second = await mountEditor({ value: '{"second": true}' });
    expect(h.created).toBe(2);
    expect(second.view.state.doc.toString()).toBe('{"second": true}');
    expect(document.querySelectorAll(".cm-editor")).toHaveLength(1);
    second.unmount();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("handles React's double mount (effects run, clean up, run again) with exactly one live editor", async () => {
    const { container } = render(<StrictMode><JsonEditor id="ed" value="[]" onChange={() => {}} language="json" ariaLabel="x" /></StrictMode>);
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
  });
});

describe("JsonEditor: typing", () => {
  it("reports the whole text after the user typed", async () => {
    const { view, onChange } = await mountEditor();
    typed(view, " ");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('{"a": 1} ');
    typed(view, "x", 0);
    expect(onChange).toHaveBeenLastCalledWith('x{"a": 1} ');
  });

  it("does not report a value that came in from outside", async () => {
    const { update, view, onChange } = await mountEditor();
    update({ value: '{"b": 2}' });
    expect(view.state.doc.toString()).toBe('{"b": 2}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows a parent that keeps the typed text as its value without any extra change", async () => {
    const { container } = render(<Holder />);
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    const view = viewOf(container);
    typed(view, "\n");
    typed(view, "[]");
    expect(view.state.doc.toString()).toBe('{"a": 1}\n[]');
  });

  it("replaces the text when the value changes from outside, keeping the cursor where the text did not change", async () => {
    const { update, view } = await mountEditor({ value: '{"name": "ada", "n": 1}' });
    act(() => { view.dispatch({ selection: { anchor: 3 } }); });
    update({ value: '{"name": "ada", "n": 22}' });
    expect(view.state.doc.toString()).toBe('{"name": "ada", "n": 22}');
    expect(view.state.selection.main.head).toBe(3);
  });

  it("keeps the cursor and the selection when the same text comes back", async () => {
    const { update, view } = await mountEditor({ value: '{"name": "ada"}' });
    act(() => { view.dispatch({ selection: { anchor: 4, head: 8 } }); });
    const dispatch = vi.spyOn(view, "dispatch");
    update({ value: '{"name": "ada"}', onChange: vi.fn() });
    expect(dispatch).not.toHaveBeenCalled();
    expect(view.state.selection.main.from).toBe(4);
    expect(view.state.selection.main.to).toBe(8);
  });

  it("treats CRLF text from outside as the same text as its LF form", async () => {
    const { update, view } = await mountEditor({ value: "a\nb" });
    const dispatch = vi.spyOn(view, "dispatch");
    update({ value: "a\r\nb" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps an undo history for the user's edits", async () => {
    const { view } = await mountEditor({ value: "[]" });
    typed(view, " ");
    expect(view.state.doc.toString()).toBe("[] ");
    undo(view);
    expect(view.state.doc.toString()).toBe("[]");
  });
});

describe("JsonEditor: read-only", () => {
  it("rejects edits made through the editor's own commands, and says so to assistive technology", async () => {
    const { view, container } = await mountEditor({ readOnly: true, value: "[1]" });
    expect(view.state.readOnly).toBe(true);
    view.dispatch({ selection: { anchor: 3 } });
    expect(deleteCharBackward(view)).toBe(false);
    expect(insertNewlineAndIndent(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("[1]");
    const content = container.querySelector(".cm-content") as HTMLElement;
    expect(content.getAttribute("aria-readonly")).toBe("true");
  });

  it("stays focusable and selectable (the text can be selected and copied, a keyboard user can scroll)", async () => {
    const { view, container } = await mountEditor({ readOnly: true, value: "[1, 2, 3]" });
    const content = container.querySelector(".cm-content") as HTMLElement;
    expect(content.getAttribute("contenteditable")).toBe("true");
    act(() => { view.dispatch({ selection: { anchor: 0, head: 9 } }); });
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("[1, 2, 3]");
  });

  it("shows no keyboard hint and no lint, since there is nothing to type", async () => {
    const { container } = await mountEditor({ readOnly: true, value: "{ not json" });
    expect(screen.queryByTestId("ed-tab-hint")).toBeNull();
    expect(container.querySelector(".cm-lint-marker, .cm-gutter-lint")).toBeNull();
  });

  it("can be switched between read-only and editable while mounted", async () => {
    const { update, view, container } = await mountEditor({ readOnly: true });
    expect(view.state.readOnly).toBe(true);
    update({ readOnly: false });
    expect(view.state.readOnly).toBe(false);
    expect((container.querySelector(".cm-content") as HTMLElement).hasAttribute("aria-readonly")).toBe(false);
    update({ readOnly: true });
    expect(view.state.readOnly).toBe(true);
  });

  it("is not editable at all when disabled", async () => {
    const { view, container } = await mountEditor({ disabled: true });
    expect(view.state.readOnly).toBe(true);
    expect((container.querySelector(".cm-content") as HTMLElement).getAttribute("contenteditable")).toBe("false");
    expect((container.querySelector(".cm-content") as HTMLElement).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("JsonEditor: the language", () => {
  it("switches between JSON and YAML, and the new text, while mounted", async () => {
    const { update, view, container } = await mountEditor({ value: '{"a": 1}', readOnly: true });
    update({ value: "a: 1\n", language: "yaml" });
    expect(view.state.doc.toString()).toBe("a: 1\n");
    expect(root(container).getAttribute("data-language")).toBe("yaml");
    update({ value: '{"a": 1}', language: "json" });
    expect(view.state.doc.toString()).toBe('{"a": 1}');
    expect(root(container).getAttribute("data-language")).toBe("json");
  });
});

describe("JsonEditor: accessibility", () => {
  it("names the editable area, gives it the id and the form's aria attributes", async () => {
    const { container } = await mountEditor({ required: true, invalid: true, describedBy: "ed-error ed-hint" });
    const content = container.querySelector(".cm-content") as HTMLElement;
    expect(content.id).toBe("ed");
    expect(content.getAttribute("aria-label")).toBe("Example payload");
    expect(content.getAttribute("role")).toBe("textbox");
    expect(content.getAttribute("aria-multiline")).toBe("true");
    expect(content.getAttribute("aria-required")).toBe("true");
    expect(content.getAttribute("aria-invalid")).toBe("true");
    expect(content.getAttribute("aria-describedby")).toBe("ed-error ed-hint ed-tab-hint");
    expect(content.getAttribute("spellcheck")).toBe("false");
    expect(screen.getByLabelText("Example payload")).toBe(content);
  });

  it("follows a change of the name and of the field's state", async () => {
    const { update, container } = await mountEditor();
    const content = () => container.querySelector(".cm-content") as HTMLElement;
    expect(content().hasAttribute("aria-invalid")).toBe(false);
    update({ ariaLabel: "Headers", invalid: true });
    expect(content().getAttribute("aria-label")).toBe("Headers");
    expect(content().getAttribute("aria-invalid")).toBe("true");
  });

  it("tells keyboard users how to leave: a hint, shown while the editor has focus", async () => {
    const { view } = await mountEditor();
    const hint = screen.getByTestId("ed-tab-hint");
    expect(hint.textContent).toBe("Press Esc, then Tab to leave the editor");
    expect(hint.getAttribute("data-visible")).toBe("false");
    expect(hint.className).toContain("sr-only");

    act(() => { view.focus(); });
    await waitFor(() => expect(screen.getByTestId("ed-tab-hint").getAttribute("data-visible")).toBe("true"));
    expect(screen.getByTestId("ed-tab-hint").className).not.toContain("sr-only");

    act(() => { view.contentDOM.blur(); });
    await waitFor(() => expect(screen.getByTestId("ed-tab-hint").getAttribute("data-visible")).toBe("false"));
  });

  it("does not trap the keyboard: Tab indents, but Esc then Tab leaves the editor", async () => {
    const { view } = await mountEditor({ value: "" });
    const press = (key: string, keyCode: number) => fireEvent.keyDown(view.contentDOM, { key, keyCode });
    // Tab alone is taken by the editor (indent), so the browser does not move focus: the event is cancelled.
    expect(press("Tab", 9)).toBe(false);
    // After Esc the editor lets Tab through to the browser, which moves focus on.
    press("Escape", 27);
    expect(press("Tab", 9)).toBe(true);
  });
});

describe("JsonEditor: JSON problems", () => {
  it("reports the parse problem with line and column through onErrorChange, and null once it is fixed", async () => {
    const onErrorChange = vi.fn();
    const { container } = render(<Holder onErrorChange={onErrorChange} />);
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    const view = viewOf(container);
    expect(onErrorChange).toHaveBeenLastCalledWith(null);

    typed(view, ",");
    expect(onErrorChange.mock.calls.at(-1)?.[0]).toMatch(/line 1/i);

    act(() => { view.dispatch({ changes: { from: view.state.doc.length - 1, to: view.state.doc.length }, userEvent: "delete.backward" }); });
    expect(onErrorChange).toHaveBeenLastCalledWith(null);
  });

  it("marks the problem in the editor (a lint diagnostic on the offending character)", async () => {
    const { view } = await mountEditor({ value: '{"a": 1,}' });
    act(() => { forceLinting(view); });
    await waitFor(() => expect(diagnosticCount(view.state)).toBe(1));
  });

  it("has no marker for valid JSON", async () => {
    const { view } = await mountEditor({ value: '{"a": 1}' });
    act(() => { forceLinting(view); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(diagnosticCount(view.state)).toBe(0);
  });

  it("does not lint YAML as JSON", async () => {
    const { view } = await mountEditor({ value: "a: 1\nb: [x]\n", language: "yaml" });
    act(() => { forceLinting(view); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(diagnosticCount(view.state)).toBe(0);
  });
});
