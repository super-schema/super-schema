// @vitest-environment jsdom
// The schema support of the JSON editor, through the REAL CodeMirror editor (jsdom with the stand-ins of ./codemirror-jsdom) and the
// REAL `codemirror-json-schema` (loaded because vitest.config.ts inlines it). Three levels: the handle (`createEditor().setSchema`),
// `JsonEditor` with a `schema` prop, and `JsonControl`. The library's functions that matter are wrapped in counters, so a test can say
// "this did not call updateSchema again".
// A schema violation is only ever a warning: it never reaches `onErrorChange` and never stops `JsonControl` from writing.
import "./codemirror-jsdom";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { forceLinting, forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { act, cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEditor, type EditorHandle, type EditorOptions } from "@/features/events/builder/template/controls/codemirror-setup";
import { JsonControl } from "@/features/events/builder/template/controls/JsonControl";
import { JsonEditor } from "@/features/events/builder/template/controls/JsonEditor";
import type { ControlProps } from "@/features/events/builder/template/controls/types";

// The first test pays the cold dynamic import of the editor setup and the schema library (about 1 s idle, over 5 s under a loaded full run).
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await import("@/features/events/builder/template/controls/codemirror-setup");
  await import("codemirror-json-schema");
  await import("@codemirror/autocomplete");
}, 60_000);

const h = vi.hoisted(() => ({ loads: 0, updates: 0, hovers: 0, completions: 0, failApply: 0 }));
vi.mock("codemirror-json-schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("codemirror-json-schema")>();
  h.loads++;
  return {
    ...actual,
    stateExtensions: (...args: Parameters<typeof actual.stateExtensions>) => {
      if (h.failApply > 0) {
        h.failApply--;
        throw new Error("the library would not take this schema");
      }
      return actual.stateExtensions(...args);
    },
    updateSchema: (...args: Parameters<typeof actual.updateSchema>) => {
      h.updates++;
      return actual.updateSchema(...args);
    },
    jsonSchemaHover: (...args: Parameters<typeof actual.jsonSchemaHover>) => {
      h.hovers++;
      return actual.jsonSchemaHover(...args);
    },
    jsonCompletion: (...args: Parameters<typeof actual.jsonCompletion>) => {
      h.completions++;
      return actual.jsonCompletion(...args);
    },
  };
});

const OPTIONS: EditorOptions = {
  language: "json", readOnly: false, disabled: false, fill: false, id: "ed", ariaLabel: "Payload",
  invalid: false, required: false, describedBy: undefined, placeholder: undefined,
};

// Markers arrive after the linter's 250 ms delay (or at once when forced); a loaded machine needs more than the 1 s default.
configure({ asyncUtilTimeout: 4000 });

type Schema = Record<string, unknown>;
const ORDER: Schema = {
  type: "object",
  properties: {
    orderId: { type: "string", description: "The id of the order." },
    quantity: { type: "integer" },
    lines: { type: "array", items: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] } },
  },
  required: ["orderId"],
  additionalProperties: false,
};
/** The same document, but `orderId` must be a number. */
const NUMERIC_ORDER: Schema = { ...ORDER, properties: { ...(ORDER.properties as Schema), orderId: { type: "number" } } };

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

interface Marker { severity: string; message: string; source: string | undefined; text: string }
/** What the editor marks now: severity, message, source and the text under the marker. */
function markers(view: EditorView): Marker[] {
  const found: Marker[] = [];
  forEachDiagnostic(view.state, (d, from, to) => found.push({ severity: d.severity, message: d.message, source: d.source, text: view.state.sliceDoc(from, to) }));
  return found;
}
const replaceDoc = (view: EditorView, text: string) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.paste" });

const handles: EditorHandle[] = [];
function make(doc: string, over: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const onChange = vi.fn();
  const handle = createEditor({ parent, doc, options: { ...OPTIONS, ...over }, onChange, onFocusChange: vi.fn() });
  handles.push(handle);
  return { handle, view: handle.view, onChange };
}
afterEach(() => {
  cleanup();
  for (const handle of handles.splice(0)) handle.destroy();
  document.body.innerHTML = "";
});

describe("EditorHandle.setSchema", () => {
  it("marks a value of the wrong type as a warning, with the schema's message, on the value", async () => {
    const { handle, view } = make('{"orderId": 5}');
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    const [marker] = markers(view);
    expect(marker.severity).toBe("warning");
    expect(marker.message).toBe("Expected `string` but received `number`");
    expect(marker.text).toBe("5");
  });

  it("marks values deep in objects and arrays at their own place", async () => {
    const text = '{\n  "orderId": "o-1",\n  "quantity": "many",\n  "lines": [{ "sku": "a" }, { "sku": 7 }]\n}';
    const { handle, view } = make(text);
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(2));
    expect(markers(view).map((m) => m.text).sort()).toEqual(['"many"', "7"]);
    expect(markers(view).every((m) => m.severity === "warning" && /Expected `(?:integer|string)` but received/.test(m.message))).toBe(true);
  });

  it("marks an unknown property on its name, and a missing required property on the first character", async () => {
    const { handle, view } = make('{"orderId": "o-1", "colour": "red"}');
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0].text).toBe('"colour"');
    expect(markers(view)[0].severity).toBe("warning");

    replaceDoc(view, '{ "quantity": 1 }');
    forceLinting(view);
    await waitFor(() => expect(markers(view).map((m) => m.text)).toEqual(["{"]));
    expect(markers(view)[0].message).toMatch(/orderId/);
  });

  it("has no markers for a value that matches, and for an empty document", async () => {
    const { handle, view } = make('{"orderId": "o-1", "quantity": 2, "lines": [{"sku": "a"}]}');
    await handle.setSchema(ORDER);
    await sleep(300);
    expect(markers(view)).toEqual([]);
    replaceDoc(view, "");
    forceLinting(view);
    await sleep(50);
    expect(markers(view)).toEqual([]);
  });

  it("clears a marker as soon as the text is fixed", async () => {
    const { handle, view } = make('{"orderId": 5}');
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    replaceDoc(view, '{"orderId": "five"}');
    await waitFor(() => expect(markers(view)).toEqual([]));
  });

  it("keeps a syntax error as the only marker, and as an error from our own lint, however much of the text the schema could read", async () => {
    const { handle, view } = make('{"orderId": 5, "quantity": ');
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0]).toMatchObject({ severity: "error", source: "JSON" });
    await sleep(300);
    expect(markers(view)).toHaveLength(1);
  });

  it("only ever warns, however many things are wrong", async () => {
    const { handle, view } = make('{"orderId": 1, "quantity": "x", "colour": 1, "lines": [{}, 3]}');
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view).length).toBeGreaterThanOrEqual(4));
    expect(new Set(markers(view).map((m) => m.severity))).toEqual(new Set(["warning"]));
  });

  it("re-lints at once when the schema is swapped, without a change of the text", async () => {
    const { handle, view } = make('{"orderId": 5}');
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    await handle.setSchema(NUMERIC_ORDER);
    await waitFor(() => expect(markers(view)).toEqual([]));
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    // the swap went through updateSchema, not through a new editor state
    expect(h.updates).toBeGreaterThanOrEqual(2);
  });

  it("removes the markers, completion and hover with a null schema, and the syntax lint carries on", async () => {
    const { handle, view } = make('{"orderId": 5}');
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(view.state.languageDataAt("autocomplete", 1)).toHaveLength(1);
    await handle.setSchema(null);
    await waitFor(() => expect(markers(view)).toEqual([]));
    expect(view.state.languageDataAt("autocomplete", 1)).toHaveLength(0);

    replaceDoc(view, '{"a": ');
    forceLinting(view);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0]).toMatchObject({ severity: "error", source: "JSON" });
  });

  it("does nothing for no schema when there was none", async () => {
    const { handle, view } = make('{"orderId": 5}');
    const dispatch = vi.spyOn(view, "dispatch");
    await handle.setSchema(null);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("compares schemas by content: the same schema rebuilt as a new object, or with its keys reordered, changes nothing", async () => {
    const { handle, view } = make('{"orderId": 5}');
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    const updatesBefore = h.updates;
    const dispatch = vi.spyOn(view, "dispatch");

    await handle.setSchema(JSON.parse(JSON.stringify(ORDER)) as Schema);
    await handle.setSchema({ additionalProperties: false, required: ["orderId"], properties: ORDER.properties, type: "object" });
    await handle.setSchema({ ...ORDER });
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.updates).toBe(updatesBefore);

    await handle.setSchema({ ...ORDER, additionalProperties: true });
    expect(h.updates).toBe(updatesBefore + 1);
  });

  it("applies only the last of several schemas asked for in a row", async () => {
    const { handle, view } = make('{"orderId": 5}');
    const first = handle.setSchema(ORDER);
    const second = handle.setSchema(NUMERIC_ORDER);
    await Promise.all([first, second]);
    await sleep(300);
    expect(markers(view)).toEqual([]);

    const install = handle.setSchema(ORDER);
    const remove = handle.setSchema(null);
    await Promise.all([install, remove]);
    await sleep(300);
    expect(markers(view)).toEqual([]);
    expect(view.state.languageDataAt("autocomplete", 1)).toHaveLength(0);
  });

  it("does not touch an editor that was destroyed while the library loaded", async () => {
    const { handle } = make('{"orderId": 5}');
    const pending = handle.setSchema(ORDER);
    handle.destroy();
    handles.length = 0;
    await expect(pending).resolves.toBeUndefined();
  });

  it("loads the library once, however many editors and schemas there are", async () => {
    const one = make("{}");
    const two = make("{}");
    await Promise.all([one.handle.setSchema(ORDER), two.handle.setSchema(NUMERIC_ORDER)]);
    await one.handle.setSchema(NUMERIC_ORDER);
    expect(h.loads).toBe(1);
  });

  it("stays an editor without a schema when the library will not take one, and takes the next", async () => {
    const { handle, view } = make('{"orderId": 5}');
    h.failApply = 1;
    await expect(handle.setSchema(ORDER)).resolves.toBeUndefined();
    expect(view.state.languageDataAt("autocomplete", 1)).toHaveLength(0);
    await sleep(300);
    expect(markers(view)).toEqual([]);
    // the same schema again is not taken for "already held"
    await handle.setSchema(ORDER);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
  });

  it("copes with a payload schema of 1,000 properties (250 KB) and a document of 85 KB: it installs, lints and stays responsive", async () => {
    const properties: Record<string, unknown> = {};
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      properties[`field${i}`] = {
        type: "object", required: ["a"],
        properties: { a: { type: "string", description: "d".repeat(80) }, b: { type: "integer" }, c: { type: "array", items: { type: "string" } } },
      };
      payload[`field${i}`] = { a: i % 10 === 0 ? 5 : "x", b: 1, c: ["q", "r"] };
    }
    const { handle, view } = make(JSON.stringify(payload, null, 2));
    await handle.setSchema({ type: "object", properties });
    await waitFor(() => expect(markers(view)).toHaveLength(100));
    expect(markers(view).every((m) => m.severity === "warning" && m.text === "5")).toBe(true);
    // an edit is linted again (the same cost once more), and the editor takes it at once
    replaceDoc(view, JSON.stringify({ ...payload, field0: { a: "fixed", b: 1, c: [] } }, null, 2));
    forceLinting(view);
    await waitFor(() => expect(markers(view)).toHaveLength(99));
  });
});

describe("what a schema installs", () => {
  it("installs completion that offers the schema's properties inside a property name", async () => {
    const { handle, view } = make('{"": 1}');
    expect(view.state.languageDataAt("autocomplete", 2)).toHaveLength(0);
    const completionsBefore = h.completions;
    await handle.setSchema(ORDER);
    expect(h.completions).toBe(completionsBefore + 1);
    const [source] = view.state.languageDataAt<(context: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>>("autocomplete", 2);
    const result = await source(new CompletionContext(view.state, 2, true));
    expect(result?.options.map((option) => option.label)).toEqual(expect.arrayContaining(["orderId", "quantity", "lines"]));
  });

  it("installs hover that describes the property under the pointer, from the schema the editor holds", async () => {
    const hoversBefore = h.hovers;
    const { handle, view } = make('{"orderId": "o-1"}');
    await handle.setSchema(ORDER);
    expect(h.hovers).toBe(hoversBefore + 1);
    const { jsonSchemaHover } = await import("codemirror-json-schema");
    const tooltip = await jsonSchemaHover()(view, 3, 1);
    expect(tooltip).not.toBeNull();
    const dom = tooltip?.create(view).dom;
    expect(dom?.textContent).toContain("The id of the order.");
    expect(dom?.textContent).toContain("string");
  });
});

describe("JsonEditor with a schema", () => {
  const editor = (props: Partial<React.ComponentProps<typeof JsonEditor>> = {}) => (
    <JsonEditor id="ed" value='{"orderId": 5}' language="json" ariaLabel="Payload" schema={ORDER} {...props} />
  );
  async function viewOf(container: HTMLElement) {
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    return EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement) as EditorView;
  }

  it("shows the violation as a warning and never reports it as a problem of the text", async () => {
    const onErrorChange = vi.fn();
    const { container } = render(editor({ onErrorChange }));
    const view = await viewOf(container);
    await waitFor(() => expect(markers(view).map((m) => m.severity)).toEqual(["warning"]));
    expect(onErrorChange.mock.calls).toEqual([[null]]);
  });

  it("still reports a syntax error, which the schema does not hide", async () => {
    const onErrorChange = vi.fn();
    const { container, rerender } = render(editor({ onErrorChange }));
    const view = await viewOf(container);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    rerender(editor({ onErrorChange, value: '{"orderId": ' }));
    await waitFor(() => expect(onErrorChange).toHaveBeenLastCalledWith(expect.stringMatching(/line 1/)));
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0]).toMatchObject({ severity: "error", source: "JSON" });
    rerender(editor({ onErrorChange, value: '{"orderId": "o-1"}' }));
    await waitFor(() => expect(onErrorChange).toHaveBeenLastCalledWith(null));
    await waitFor(() => expect(markers(view)).toEqual([]));
  });

  it("follows a schema that changes, and drops it for null or undefined", async () => {
    const { container, rerender } = render(editor());
    const view = await viewOf(container);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    rerender(editor({ schema: NUMERIC_ORDER }));
    await waitFor(() => expect(markers(view)).toEqual([]));
    rerender(editor({ schema: ORDER }));
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    rerender(editor({ schema: null }));
    await waitFor(() => expect(markers(view)).toEqual([]));
    rerender(editor({ schema: ORDER }));
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    rerender(editor({ schema: undefined }));
    await waitFor(() => expect(markers(view)).toEqual([]));
  });

  it("does not reconfigure anything when a parent hands it a new, equal schema object on every render", async () => {
    const { container, rerender } = render(editor({ schema: { ...ORDER } }));
    const view = await viewOf(container);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    const dispatch = vi.spyOn(view, "dispatch");
    const updatesBefore = h.updates;
    for (let i = 0; i < 6; i++) {
      rerender(editor({ schema: JSON.parse(JSON.stringify(ORDER)) as Schema }));
      await act(async () => { await sleep(5); });
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.updates).toBe(updatesBefore);
    expect(markers(view)).toHaveLength(1);
  });

  it("validates JSON only, and only while the text can be edited", async () => {
    const { container, rerender } = render(editor({ readOnly: true }));
    const view = await viewOf(container);
    await sleep(350);
    expect(markers(view)).toEqual([]);
    expect(view.state.languageDataAt("autocomplete", 1)).toHaveLength(0);
    rerender(editor({ readOnly: false }));
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    rerender(editor({ readOnly: false, language: "yaml", value: "orderId: 5" }));
    await waitFor(() => expect(markers(view)).toEqual([]));
  });
});

describe("JsonControl with a schema", () => {
  const FIELD = { key: "payload", label: "Payload", kind: "json", group: "basics" } as ControlProps["field"];
  function control(over: Partial<ControlProps> = {}) {
    const onChange = vi.fn();
    const props: ControlProps = {
      field: FIELD, id: "f-payload", value: undefined, onChange, required: false, invalid: false, path: "/payload",
      renderFields: () => null, schema: ORDER, ...over,
    };
    return { onChange, props };
  }
  async function mount(over: Partial<ControlProps> = {}) {
    const { onChange, props } = control(over);
    const utils = render(<JsonControl {...props} />);
    await waitFor(() => expect(utils.container.querySelector(".cm-editor")).not.toBeNull());
    const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement) as EditorView;
    return { ...utils, view, onChange };
  }
  const write = (view: EditorView, text: string) => act(() => { replaceDoc(view, text); });

  it("writes a value that is valid JSON but breaks the schema, and warns about it", async () => {
    const { view, onChange } = await mount();
    write(view, '{"orderId": 5, "colour": "red"}');
    expect(onChange).toHaveBeenLastCalledWith({ orderId: 5, colour: "red" });
    expect(screen.queryByTestId("f-payload-validation")).toBeNull();
    expect(view.contentDOM.hasAttribute("aria-invalid")).toBe(false);
    await waitFor(() => expect(markers(view).map((m) => m.severity)).toEqual(["warning", "warning"]));
  });

  it("writes a value that matches, with no marker", async () => {
    const { view, onChange } = await mount({ value: { orderId: "o-1" } });
    write(view, '{"orderId": "o-2", "quantity": 3}');
    expect(onChange).toHaveBeenLastCalledWith({ orderId: "o-2", quantity: 3 });
    await sleep(300);
    expect(markers(view)).toEqual([]);
  });

  it("still keeps invalid JSON in the editor with its message and writes nothing", async () => {
    const { view, onChange } = await mount({ value: { orderId: "o-1" } });
    write(view, '{"orderId": ');
    expect(screen.getByTestId("f-payload-validation").textContent).toMatch(/^Not valid JSON: /);
    expect(view.contentDOM.getAttribute("aria-invalid")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0]).toMatchObject({ severity: "error", source: "JSON" });
  });

  it("does not warn at all without a schema", async () => {
    const { view, onChange } = await mount({ schema: null });
    write(view, '{"orderId": 5}');
    expect(onChange).toHaveBeenLastCalledWith({ orderId: 5 });
    await sleep(300);
    expect(markers(view)).toEqual([]);
  });
});
