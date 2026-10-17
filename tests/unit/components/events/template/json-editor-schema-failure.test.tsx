// @vitest-environment jsdom
// When the schema library cannot be loaded, the editor works without schema support: no exception, no banner, and a later schema
// tries to load it again. (A file of its own, like json-editor-failure.test.tsx: a module that loaded once stays loaded for the rest of
// a file, so a test that needs a failing load must come before any test that lets the library load. Keep the order.)
import "./codemirror-jsdom";
import { forceLinting, forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEditor, type EditorHandle, type EditorOptions } from "@/features/events/builder/template/controls/codemirror-setup";
import { JsonEditor } from "@/features/events/builder/template/controls/JsonEditor";

// The first test pays the cold dynamic import of the editor setup (about 1 s idle, over 5 s under a loaded full run), the second the real
// library. The library is warmed with `vi.importActual`, NOT `import()`: an import() would run the mock below once, successfully, and the
// first test (a library that fails to load) could never see its failure. The mock's `importOriginal()` then finds the real module cached.
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await import("@/features/events/builder/template/controls/codemirror-setup");
  await vi.importActual("codemirror-json-schema");
  await import("@codemirror/autocomplete");
}, 60_000);

const h = vi.hoisted(() => ({ loads: 0, failLoads: 0 }));
vi.mock("codemirror-json-schema", async (importOriginal) => {
  h.loads++;
  if (h.failLoads > 0) {
    h.failLoads--;
    throw new Error("Loading chunk failed");
  }
  return importOriginal();
});

const OPTIONS: EditorOptions = {
  language: "json", readOnly: false, disabled: false, fill: false, id: "ed", ariaLabel: "Payload",
  invalid: false, required: false, describedBy: undefined, placeholder: undefined,
};
const SCHEMA = { type: "object", properties: { orderId: { type: "string" } } };

configure({ asyncUtilTimeout: 4000 }); // a loaded machine needs more than the 1 s default
const severities = (view: EditorView) => {
  const found: string[] = [];
  forEachDiagnostic(view.state, (d) => found.push(`${d.severity}:${d.source}`));
  return found;
};
const replaceDoc = (view: EditorView, text: string) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.paste" });
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const handles: EditorHandle[] = [];
afterEach(() => {
  cleanup();
  for (const handle of handles.splice(0)) handle.destroy();
  document.body.innerHTML = "";
  h.failLoads = 0;
});

describe("the schema library fails to load", () => {
  it("keeps JsonEditor on CodeMirror, working, with no message about it", async () => {
    h.failLoads = 1;
    const onChange = vi.fn();
    const onErrorChange = vi.fn();
    const { container } = render(
      <JsonEditor id="ed" value='{"orderId": 5}' onChange={onChange} onErrorChange={onErrorChange} language="json" ariaLabel="Payload" schema={SCHEMA} />,
    );
    await waitFor(() => expect(h.loads).toBe(1));
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement) as EditorView;
    expect(container.firstElementChild?.getAttribute("data-editor")).toBe("codemirror");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onErrorChange.mock.calls).toEqual([[null]]);

    replaceDoc(view, '{"orderId": "o-1"}');
    expect(onChange).toHaveBeenLastCalledWith('{"orderId": "o-1"}');
    forceLinting(view);
    await sleep(50);
    expect(severities(view)).toEqual([]);
    expect(view.state.languageDataAt("autocomplete", 1)).toHaveLength(0);
  });

  it("leaves a handle working with no schema support, and loads again on the next schema", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const onChange = vi.fn();
    const handle = createEditor({ parent, doc: '{"orderId": 5}', options: OPTIONS, onChange, onFocusChange: vi.fn() });
    handles.push(handle);
    const { view } = handle;
    const loadsBefore = h.loads;

    h.failLoads = 1;
    await expect(handle.setSchema(SCHEMA)).resolves.toBeUndefined();
    expect(h.loads).toBe(loadsBefore + 1);
    expect(view.state.languageDataAt("autocomplete", 1)).toHaveLength(0);

    // typing and the syntax lint work as before; there is no schema marker
    view.dispatch({ changes: { from: 0, insert: " " }, userEvent: "input.type" });
    expect(onChange).toHaveBeenCalledWith(' {"orderId": 5}');
    replaceDoc(view, '{"orderId": ');
    forceLinting(view);
    await waitFor(() => expect(severities(view)).toEqual(["error:JSON"]));

    // the next schema loads the library for real
    replaceDoc(view, '{"orderId": 5}');
    await handle.setSchema(SCHEMA);
    expect(h.loads).toBe(loadsBefore + 2);
    await waitFor(() => expect(severities(view)).toEqual(["warning:json-schema"]));
  });
});
