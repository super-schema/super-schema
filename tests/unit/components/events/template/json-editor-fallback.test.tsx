// @vitest-environment jsdom
// JsonEditor WITHOUT the CodeMirror jsdom shims: jsdom cannot run CodeMirror, so the editor stays on its textarea, which has the
// same API. This is also what every other test of a form that contains a JSON field sees.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ createEditor: vi.fn() }));
vi.mock("@/features/events/builder/template/controls/codemirror-setup", () => ({ createEditor: h.createEditor }));

import { JsonEditor, codeMirrorSupported, type JsonEditorProps } from "@/features/events/builder/template/controls/JsonEditor";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const area = () => screen.getByTestId("ed") as HTMLTextAreaElement;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

function mount(over: Partial<JsonEditorProps> = {}) {
  const onChange = vi.fn();
  const props: JsonEditorProps = { id: "ed", value: '{"a":1}', onChange, language: "json", ariaLabel: "Example payload", ...over };
  const utils = render(<JsonEditor {...props} />);
  return { ...utils, onChange, props, update: (next: Partial<JsonEditorProps>) => utils.rerender(<JsonEditor {...props} {...next} />) };
}

describe("JsonEditor: the textarea fallback", () => {
  it("is a textarea with the id, the value, an accessible name and no spell checking", () => {
    mount();
    expect(area().tagName).toBe("TEXTAREA");
    expect(area().id).toBe("ed");
    expect(area().value).toBe('{"a":1}');
    expect(area().getAttribute("aria-label")).toBe("Example payload");
    expect(screen.getByLabelText("Example payload")).toBe(area());
    expect(area().getAttribute("spellcheck")).toBe("false");
  });

  it("tells which editor it is: a plain textarea, in the language it was given", () => {
    const { container } = mount({ language: "yaml" });
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-editor")).toBe("textarea");
    expect(root.getAttribute("data-language")).toBe("yaml");
  });

  it("reports what the user types, as the whole text", () => {
    const { onChange } = mount();
    fireEvent.change(area(), { target: { value: '{"a":2}' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('{"a":2}');
  });

  it("shows a new value from outside", () => {
    const { update } = mount();
    update({ value: '{"b":true}' });
    expect(area().value).toBe('{"b":true}');
  });

  it("is read-only when asked to be: selectable, focusable, and it says so", () => {
    mount({ readOnly: true });
    expect(area().readOnly).toBe(true);
    expect(area().disabled).toBe(false);
    expect(area().getAttribute("wrap")).toBe("off");
  });

  it("is not read-only by default and wraps its lines", () => {
    mount();
    expect(area().readOnly).toBe(false);
    expect(area().getAttribute("wrap")).toBeNull();
  });

  it("can be disabled", () => {
    mount({ disabled: true });
    expect(area().disabled).toBe(true);
  });

  it("passes on what a form needs: required, invalid, described-by and a placeholder", () => {
    mount({ required: true, invalid: true, describedBy: "ed-error ed-hint", placeholder: '{ "traceId": "abc" }' });
    expect(area().getAttribute("aria-required")).toBe("true");
    expect(area().getAttribute("aria-invalid")).toBe("true");
    expect(area().getAttribute("aria-describedby")).toBe("ed-error ed-hint");
    expect(area().placeholder).toBe('{ "traceId": "abc" }');
  });

  it("leaves the aria attributes off when there is nothing to say", () => {
    mount();
    for (const name of ["aria-required", "aria-invalid", "aria-describedby"]) expect(area().hasAttribute(name)).toBe(false);
  });

  it("has no keyboard hint: the textarea is not a keyboard trap", () => {
    mount();
    expect(screen.queryByTestId("ed-tab-hint")).toBeNull();
  });

  it("gives the root the height it was asked for", () => {
    const { container } = mount({ height: "100%" });
    expect((container.firstElementChild as HTMLElement).style.height).toBe("100%");
    cleanup();
    const second = mount({ height: 180 });
    expect((second.container.firstElementChild as HTMLElement).style.height).toBe("180px");
  });

  it("does not need an onChange when read-only", () => {
    expect(() => mount({ onChange: undefined, readOnly: true })).not.toThrow();
  });
});

describe("JsonEditor: CodeMirror is not started where it cannot run", () => {
  it("reports that jsdom without shims cannot run CodeMirror", () => {
    expect(codeMirrorSupported()).toBe(false);
  });

  it("never asks for the editor, even after the page had time to load it", async () => {
    mount();
    await flush();
    expect(h.createEditor).not.toHaveBeenCalled();
    expect(area().tagName).toBe("TEXTAREA");
  });
});

describe("JsonEditor: onErrorChange", () => {
  it("reports the parse problem of JSON text, with its line and column, and null once it is fixed", () => {
    const onErrorChange = vi.fn();
    const { update } = mount({ value: '{"a":1}', onErrorChange });
    expect(onErrorChange).toHaveBeenLastCalledWith(null);

    update({ value: '{\n  "a": 1,\n}', onErrorChange });
    const message = onErrorChange.mock.calls.at(-1)?.[0] as string;
    expect(typeof message).toBe("string");
    expect(message).toMatch(/line 3/i);

    update({ value: '{"a":2}', onErrorChange });
    expect(onErrorChange).toHaveBeenLastCalledWith(null);
  });

  it("reports each problem once, not on every render", () => {
    const onErrorChange = vi.fn();
    const { update } = mount({ value: "{ oops", onErrorChange });
    expect(onErrorChange).toHaveBeenCalledTimes(1);
    update({ value: "{ oops", onErrorChange: vi.fn(onErrorChange) });
    update({ value: "{ oops", onErrorChange });
    expect(onErrorChange).toHaveBeenCalledTimes(1);
  });

  it("treats empty text as no problem", () => {
    const onErrorChange = vi.fn();
    mount({ value: "", onErrorChange });
    expect(onErrorChange).toHaveBeenLastCalledWith(null);
  });

  it("has no JSON problems to report for YAML", () => {
    const onErrorChange = vi.fn();
    mount({ value: "a: [unclosed", language: "yaml", onErrorChange });
    expect(onErrorChange).toHaveBeenLastCalledWith(null);
  });

  it("clears a JSON problem when the language becomes YAML", () => {
    const onErrorChange = vi.fn();
    const { update } = mount({ value: "{ oops", onErrorChange });
    expect(onErrorChange.mock.calls.at(-1)?.[0]).not.toBeNull();
    update({ language: "yaml", onErrorChange });
    expect(onErrorChange).toHaveBeenLastCalledWith(null);
  });
});
