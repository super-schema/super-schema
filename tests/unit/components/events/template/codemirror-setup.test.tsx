// @vitest-environment jsdom
// The pure pieces of the CodeMirror setup (extensions, theme, highlight style, lint source) and its handle, without React.
import "./codemirror-jsdom";
import { defaultKeymap } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap as keymapFacet } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appHighlightStyle, buildExtensions, createEditor, lintJson, type EditorHandle, type EditorOptions,
} from "@/features/events/builder/template/controls/codemirror-setup";

const OPTIONS: EditorOptions = {
  language: "json", readOnly: false, disabled: false, fill: false, id: "ed", ariaLabel: "Payload",
  invalid: false, required: false, describedBy: undefined, placeholder: undefined,
};
const stateOf = (over: Partial<EditorOptions> = {}, doc = "") => EditorState.create({ doc, extensions: buildExtensions({ ...OPTIONS, ...over }) });

const handles: EditorHandle[] = [];
function make(over: Partial<EditorOptions> = {}, doc = '{"a": 1}') {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const onChange = vi.fn();
  const onFocusChange = vi.fn();
  const handle = createEditor({ parent, doc, options: { ...OPTIONS, ...over }, onChange, onFocusChange });
  handles.push(handle);
  return { handle, parent, onChange, onFocusChange };
}
afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  document.body.innerHTML = "";
});

describe("lintJson", () => {
  it("has no markers for valid, empty and blank text", () => {
    for (const ok of ['{"a": 1}', "[]", '"x"', "", "  \n "]) expect(lintJson(ok)).toEqual([]);
  });

  it("gives one error marker on the character the parser stopped at", () => {
    const text = '{"a": 1,}';
    const [marker, ...rest] = lintJson(text);
    expect(rest).toEqual([]);
    expect(marker.severity).toBe("error");
    expect(marker.source).toBe("JSON");
    expect(marker.message).toMatch(/line 1/i);
    expect(text.slice(marker.from, marker.to)).toBe("}");
  });

  it("marks the last character when the text stops short", () => {
    const text = '{"a": 1,  ';
    const [marker] = lintJson(text);
    expect(marker.from).toBeGreaterThanOrEqual(0);
    expect(marker.to).toBeGreaterThan(marker.from);
    expect(marker.to).toBeLessThanOrEqual(text.length);
    expect(text.slice(marker.from, marker.to)).toBe(",");
  });

  it("points inside the document for a one-character text", () => {
    const [marker] = lintJson("{");
    expect(marker.from).toBe(0);
    expect(marker.to).toBe(1);
  });
});

describe("buildExtensions", () => {
  it("makes the language JSON or YAML", () => {
    expect(stateOf({ language: "json" }).facet(language)?.name).toBe("json");
    expect(stateOf({ language: "yaml" }).facet(language)?.name).toBe("yaml");
  });

  it("is editable by default, with the lint, and read-only when asked", () => {
    const editable = stateOf();
    expect(editable.readOnly).toBe(false);
    expect(editable.facet(EditorView.editable)).toBe(true);
    const locked = stateOf({ readOnly: true });
    expect(locked.readOnly).toBe(true);
    expect(locked.facet(EditorView.editable)).toBe(true);
  });

  it("is neither editable nor read-write when disabled", () => {
    const disabled = stateOf({ disabled: true });
    expect(disabled.readOnly).toBe(true);
    expect(disabled.facet(EditorView.editable)).toBe(false);
  });

  it("puts the name, id and the form's state on the editable element", () => {
    const attrs = stateOf({ required: true, invalid: true, describedBy: "a b" }).facet(EditorView.contentAttributes)
      .reduce<Record<string, string>>((all, one) => ({ ...all, ...(one as Record<string, string>) }), {});
    expect(attrs).toMatchObject({
      id: "ed", "aria-label": "Payload", "aria-required": "true", "aria-invalid": "true", "aria-describedby": "a b", spellcheck: "false",
    });
    expect(attrs["aria-readonly"]).toBeUndefined();
  });

  it("says read-only on the editable element when it is", () => {
    const attrs = stateOf({ readOnly: true }).facet(EditorView.contentAttributes).reduce<Record<string, string>>((all, one) => ({ ...all, ...(one as Record<string, string>) }), {});
    expect(attrs["aria-readonly"]).toBe("true");
  });

  it("binds Tab to indentation only while it can be edited, so a read-only editor never keeps Tab", () => {
    const tabBindings = (state: EditorState) => state.facet(keymapFacet).flat().filter((binding) => binding.key === "Tab");
    expect(tabBindings(stateOf())).toHaveLength(1);
    expect(tabBindings(stateOf({ readOnly: true }))).toHaveLength(0);
    expect(tabBindings(stateOf({ disabled: true }))).toHaveLength(0);
    // every command of the default keymap is still there for moving and selecting
    const keys = stateOf({ readOnly: true }).facet(keymapFacet).flat().map((binding) => binding.key);
    expect(keys).toContain("Mod-a");
    expect(defaultKeymap.length).toBeGreaterThan(20);
  });
});

describe("theme and highlighting use the app's design tokens, never fixed colours", () => {
  const rules = () => (appHighlightStyle.module?.getRules() ?? "");

  it("colours the syntax with CSS variables of the design system", () => {
    for (const token of ["--primary", "--success", "--info", "--warning", "--muted-foreground", "--destructive"]) {
      expect(rules()).toContain(`var(${token})`);
    }
    expect(rules()).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules()).not.toMatch(/\brgba?\(/i);
  });

  it("styles the editor itself with tokens too, once it is mounted", () => {
    make();
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n");
    for (const token of ["--foreground", "--border", "--muted", "--ring", "--accent", "--popover", "--muted-foreground"]) {
      expect(css).toContain(`var(${token})`);
    }
    // the editor's own rules (those of our theme) carry no fixed colour
    const ours = css.split("}").filter((rule) => rule.includes("var(--")).join("}");
    expect(ours).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("styles the warnings of a schema, its hover text and its completion list with tokens too", () => {
    make();
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n");
    // other packages' own base themes have rules for some of these selectors too: ours is the one that uses the token
    const rule = (selector: string) => css.split("}").filter((r) => r.includes(selector)).join("}");
    expect(rule(".cm-diagnostic-warning")).toContain("var(--warning)");
    expect(rule(".cm6-json-schema-hover")).toContain("padding");
    expect(rule("aria-selected")).toContain("var(--accent-foreground)");
  });
});

describe("without a schema", () => {
  it("the base extensions carry no completion, and the editor holds no schema until it is given one", async () => {
    expect(stateOf().languageDataAt("autocomplete", 0)).toEqual([]);
    const { handle } = make();
    const dispatch = vi.spyOn(handle.view, "dispatch");
    await handle.setSchema(null);
    expect(dispatch).not.toHaveBeenCalled();
    expect(handle.view.state.languageDataAt("autocomplete", 1)).toEqual([]);
  });
});

describe("createEditor", () => {
  it("builds an editor in the parent on the document, and destroys it", () => {
    const { handle, parent } = make({}, '{"x": 1}');
    expect(parent.querySelector(".cm-editor")).not.toBeNull();
    expect(handle.view.state.doc.toString()).toBe('{"x": 1}');
    handle.destroy();
    expect(parent.querySelector(".cm-editor")).toBeNull();
    handles.length = 0;
  });

  it("reports the user's edits but not setValue", () => {
    const { handle, onChange } = make();
    handle.view.dispatch({ changes: { from: 0, insert: " " }, userEvent: "input.type" });
    expect(onChange).toHaveBeenCalledWith(' {"a": 1}');
    onChange.mockClear();
    handle.setValue("[1]");
    expect(handle.view.state.doc.toString()).toBe("[1]");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("setValue does nothing for text it already holds", () => {
    const { handle } = make();
    const dispatch = vi.spyOn(handle.view, "dispatch");
    handle.setValue('{"a": 1}');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("setValue changes only what differs, so a cursor before the change stays", () => {
    const { handle } = make({}, "hello world");
    handle.view.dispatch({ selection: { anchor: 5 } });
    handle.setValue("hello brave world");
    expect(handle.view.state.doc.toString()).toBe("hello brave world");
    expect(handle.view.state.selection.main.head).toBe(5);
  });

  it("reconfigure applies new options and ignores identical ones", () => {
    const { handle } = make();
    const dispatch = vi.spyOn(handle.view, "dispatch");
    handle.reconfigure({ ...OPTIONS });
    expect(dispatch).not.toHaveBeenCalled();
    handle.reconfigure({ ...OPTIONS, readOnly: true, language: "yaml" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(handle.view.state.readOnly).toBe(true);
    expect(handle.view.state.facet(language)?.name).toBe("yaml");
  });

  it("focus selects the range it is given, within the document", () => {
    const { handle } = make({}, "abcdef");
    handle.focus({ from: 2, to: 99 });
    expect(handle.view.state.selection.main.from).toBe(2);
    expect(handle.view.state.selection.main.to).toBe(6);
  });

  it("tells when the editor gains and loses focus", async () => {
    const { handle, onFocusChange } = make();
    handle.view.focus();
    await vi.waitFor(() => expect(onFocusChange).toHaveBeenLastCalledWith(true));
    handle.view.contentDOM.blur();
    await vi.waitFor(() => expect(onFocusChange).toHaveBeenLastCalledWith(false));
  });
});

describe("the lint state marker (data-lint-state on the editor root)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const stateOfEditor = (handle: EditorHandle) => handle.view.dom.dataset.lintState;

  it("is pending from the creation and idle once the first lint pass has set its diagnostics", async () => {
    vi.useFakeTimers();
    const { handle } = make();
    expect(stateOfEditor(handle)).toBe("pending");
    await vi.advanceTimersByTimeAsync(300);
    expect(stateOfEditor(handle)).toBe("idle");
  });

  it("goes pending on an edit and back to idle only when the pass after that edit has finished (the 250 ms debounce)", async () => {
    vi.useFakeTimers();
    const { handle } = make();
    await vi.advanceTimersByTimeAsync(300);
    expect(stateOfEditor(handle)).toBe("idle");

    handle.view.dispatch({ changes: { from: 0, to: handle.view.state.doc.length, insert: '{"orderId": 5}' } });
    expect(stateOfEditor(handle)).toBe("pending");
    await vi.advanceTimersByTimeAsync(200); // the debounce has not run out
    expect(stateOfEditor(handle)).toBe("pending");
    handle.view.dispatch({ changes: { from: 0, insert: " " } }); // another edit restarts it
    await vi.advanceTimersByTimeAsync(200);
    expect(stateOfEditor(handle)).toBe("pending");
    await vi.advanceTimersByTimeAsync(100);
    expect(stateOfEditor(handle)).toBe("idle");
  });

  it("is idle after a pass that found nothing, as well as after one that flagged something", async () => {
    vi.useFakeTimers();
    const { handle } = make({}, '{"a": 1,}'); // invalid JSON: the pass sets one error
    await vi.advanceTimersByTimeAsync(300);
    expect(stateOfEditor(handle)).toBe("idle");
    handle.view.dispatch({ changes: { from: 0, to: handle.view.state.doc.length, insert: '{"a": 1}' } }); // valid: the pass sets none
    expect(stateOfEditor(handle)).toBe("pending");
    await vi.advanceTimersByTimeAsync(300);
    expect(stateOfEditor(handle)).toBe("idle");
  });

  it("is not there on an editor that does not lint (YAML, read-only)", () => {
    expect(stateOfEditor(make({ language: "yaml" }).handle)).toBeUndefined();
    expect(stateOfEditor(make({ readOnly: true }).handle)).toBeUndefined();
  });
});
