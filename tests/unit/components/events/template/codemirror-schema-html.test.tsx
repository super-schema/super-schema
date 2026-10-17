// @vitest-environment jsdom
// The two other places where `codemirror-json-schema` 0.8.1 turns markdown into innerHTML (the hover is covered by codemirror-hover.test):
//  - the INFO of a property completion: `info: () => el("div", { inner: renderMarkdown(description) })`, so `![x](https://third.party/p.png)`
//    in a field's description is fetched as soon as that function runs;
//  - the LINT message: every diagnostic carries a `renderMessage` that sets innerHTML from markdown of the message, which holds values and
//    property names of the document; a backtick in one breaks out of the code span (`a`![x](url)`b` renders an image).
// Both go through the REAL editor (jsdom with the stand-ins of ./codemirror-jsdom) and the REAL library: the completion source the editor
// installed is asked for options and each option's `info` is rendered the way @codemirror/autocomplete does; the lint panel of the editor
// is opened and its DOM read.
import "./codemirror-jsdom";
import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import { forceLinting, openLintPanel } from "@codemirror/lint";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createEditor, textOnlyCompletion, type EditorHandle, type EditorOptions,
} from "@/features/events/builder/template/controls/codemirror-setup";

// The first test pays the cold dynamic import of the setup and the schema library; under a loaded machine that exceeds the default 5 s.
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await import("@/features/events/builder/template/controls/codemirror-setup");
  await import("codemirror-json-schema");
  await import("@codemirror/autocomplete");
}, 60_000);

const OPTIONS: EditorOptions = {
  language: "json", readOnly: false, disabled: false, fill: false, id: "ed", ariaLabel: "Payload",
  invalid: false, required: false, describedBy: undefined, placeholder: undefined,
};
const IMAGE = "![x](http://localhost/p.png)";
const DESCRIPTION = `Id. ${IMAGE} <img src=x onerror=alert(1)>`;
/** Elements that load, run or navigate: none may be anywhere the library renders text. */
const DANGEROUS = "img, script, a, iframe, svg, object, embed, link, style";

const handles: EditorHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  document.body.innerHTML = "";
});
function make(doc: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const handle = createEditor({ parent, doc, options: OPTIONS, onChange: vi.fn(), onFocusChange: vi.fn() });
  handles.push(handle);
  return handle;
}

type Source = (context: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>;
/** The completion options the editor offers at `pos` (it installed the library's source, wrapped). */
async function optionsAt(handle: EditorHandle, pos: number): Promise<readonly Completion[]> {
  const { view } = handle;
  const sources = view.state.languageDataAt<Source>("autocomplete", pos);
  expect(sources, "the editor has a completion source").toHaveLength(1);
  const result = await sources[0](new CompletionContext(view.state, pos, true));
  return result?.options ?? [];
}

/** What @codemirror/autocomplete shows for an option's `info`: a string as a text node, a function's node as it is; nothing for none. */
function renderInfo(option: Completion): HTMLElement {
  const panel = document.createElement("div");
  const info = option.info;
  if (typeof info === "string") panel.append(document.createTextNode(info));
  else if (typeof info === "function") {
    const node = info(option);
    if (node instanceof Node) panel.append(node);
    else if (node && "dom" in node && node.dom instanceof Node) panel.append(node.dom);
  }
  return panel;
}

describe("completion info", () => {
  it("never renders a property's description as markdown: no <img>, <script> or link comes out, and label, type and detail are as the library made them", async () => {
    const handle = make('{"": 1}');
    await handle.setSchema({ type: "object", properties: { orderId: { type: "string", description: DESCRIPTION }, quantity: { type: "integer" } } });
    const options = await optionsAt(handle, 2);
    const orderId = options.find((option) => option.label === "orderId");
    expect(orderId).toBeDefined();
    expect(orderId).toMatchObject({ label: "orderId", type: "property", detail: "string" });
    expect(typeof orderId?.apply).toBe("function"); // the snippet that inserts the property is untouched
    expect(options.find((option) => option.label === "quantity")).toMatchObject({ type: "property", detail: "integer" });
    for (const option of options) {
      const panel = renderInfo(option);
      expect(panel.querySelector(DANGEROUS), `info of ${option.label}`).toBeNull();
      expect(panel.innerHTML, `info of ${option.label}`).not.toContain("<img");
    }
  });

  it("shows a string info (the description of an enum value) as the literal text it is", async () => {
    const handle = make('{"kind": ""}');
    await handle.setSchema({ type: "object", properties: { kind: { enum: ["a", "b"], description: DESCRIPTION } } });
    const options = await optionsAt(handle, 10);
    const a = options.find((option) => option.label === '"a"' || option.label === "a");
    expect(a, JSON.stringify(options.map((option) => option.label))).toBeDefined();
    expect(a?.info).toBe(DESCRIPTION);
    const panel = renderInfo(a as Completion);
    expect(panel.textContent).toBe(DESCRIPTION);
    expect(panel.querySelector(DANGEROUS)).toBeNull();
  });

  it("drops an info that is not text at all (a schema's description may be any JSON; a non-string would be called as a function)", async () => {
    const handle = make('{"kind": ""}');
    await handle.setSchema({ type: "object", properties: { kind: { enum: ["a"], description: { not: "text" } } } });
    const options = await optionsAt(handle, 10);
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) expect(option.info === undefined || typeof option.info === "string", option.label).toBe(true);
  });

  it("textOnlyCompletion passes an empty answer through and leaves every other part of the result alone", () => {
    const state = make("{}").view.state;
    const context = new CompletionContext(state, 1, true);
    const empty = textOnlyCompletion(() => []);
    expect(empty(context)).toEqual([]);
    const apply = () => {};
    const wrapped = textOnlyCompletion(() => ({
      from: 1, to: 1, filter: false, validFor: /^\w*$/,
      options: [{ label: "x", type: "property", detail: "string", boost: 2, apply, info: () => document.createElement("img") }, { label: "y", info: "plain" }, { label: "z" }],
    }))(context) as CompletionResult;
    expect(wrapped).toMatchObject({ from: 1, to: 1, filter: false });
    expect(wrapped.validFor).toEqual(/^\w*$/);
    expect(wrapped.options[0]).toEqual({ label: "x", type: "property", detail: "string", boost: 2, apply });
    expect(wrapped.options[1]).toEqual({ label: "y", info: "plain" });
    expect(wrapped.options[2]).toEqual({ label: "z" });
  });
});

describe("lint messages", () => {
  /** The rendered text of every diagnostic in the editor's lint panel (the real @codemirror/lint DOM). */
  async function panelOf(handle: EditorHandle): Promise<HTMLElement> {
    const { view } = handle;
    forceLinting(view);
    openLintPanel(view);
    await waitFor(() => expect(view.dom.querySelector(".cm-panel-lint .cm-diagnostic")).not.toBeNull());
    return view.dom.querySelector(".cm-panel-lint") as HTMLElement;
  }

  it("shows a message with a backtick-broken image link as text: the message is the one the library wrote, and no <img> is in the panel", async () => {
    // json-schema-library puts the offending VALUE in backticks into the message: this one closes the code span and opens an image
    const value = `a\`${IMAGE}\`b`;
    const handle = make(JSON.stringify({ kind: value }));
    await handle.setSchema({ type: "object", properties: { kind: { enum: ["x", "y"] } } });
    const panel = await panelOf(handle);
    const diagnostic = panel.querySelector(".cm-diagnostic") as HTMLElement;
    expect(diagnostic.classList.contains("cm-diagnostic-warning")).toBe(true);
    expect(panel.querySelector(DANGEROUS)).toBeNull();
    expect(panel.innerHTML).not.toContain("<img");
    expect(panel.querySelector("code")).toBeNull();
    // the text of the message is all there, literally, markdown characters included (the library rewrites "/" to "." in it)
    expect(diagnostic.textContent).toContain("Expected given value `a`![x](http:..localhost.p.png)`b` in `kind`");
  });

  it("still marks a plain violation as a warning with the library's message (the markers are unchanged)", async () => {
    const handle = make('{"orderId": 5}');
    await handle.setSchema({ type: "object", properties: { orderId: { type: "string" } } });
    const panel = await panelOf(handle);
    expect(panel.querySelector(".cm-diagnostic-warning")?.textContent).toContain("Expected `string` but received `number`");
    expect(panel.querySelector(DANGEROUS)).toBeNull();
  });
});
