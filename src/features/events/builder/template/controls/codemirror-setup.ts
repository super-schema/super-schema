// src/features/events/builder/template/controls/codemirror-setup.ts
// The CodeMirror 6 side of `JsonEditor`: extensions, theme, highlight style, JSON lint source and the small handle the React wrapper
// drives. Together with `JsonEditor.tsx` this is the ONLY file that imports `@codemirror/*`, `@lezer/*` or `codemirror-json-schema`
// (a test enforces it). It is loaded on demand with `import()` from `JsonEditor.tsx`, so none of it is in the first bundle of a page.
// The schema support (`codemirror-json-schema` and `@codemirror/autocomplete`) is a second step: it is loaded with its own `import()`,
// the first time an editor is given a schema, and never otherwise.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json, jsonLanguage } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, ensureSyntaxTree, HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { forceLinting, linter, lintGutter, setDiagnosticsEffect, type Diagnostic } from "@codemirror/lint";
import { Annotation, Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import {
  Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, hoverTooltip, keymap, lineNumbers, placeholder,
  ViewPlugin,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tags } from "@lezer/highlight";
import { jsonProblem, minimalChange, normalizeLineBreaks, schemaKey } from "./editor-text";

export type EditorLanguage = "json" | "yaml";

/** Everything about the editor that can change while it is mounted; `JsonEditor` derives it from its props. */
export interface EditorOptions {
  language: EditorLanguage;
  readOnly: boolean;
  disabled: boolean;
  /** Fill the height the parent gives it (the parent sets one); otherwise grow with the text, between a minimum and a maximum. */
  fill: boolean;
  /** Id of the editable element (so a `<label for>` and ids in `aria-describedby` keep working). */
  id: string;
  ariaLabel: string;
  invalid: boolean;
  required: boolean;
  describedBy: string | undefined;
  placeholder: string | undefined;
}

/** Marks a change made from outside (a new `value` prop): it must not be reported back through `onChange`. */
const External = Annotation.define<boolean>();

// ---------------------------------------------------------------------------------------------------------------------------
// Highlighting and theme. Colours are the app's design tokens as CSS variables, so the light and the dark theme both work and
// follow a theme switch without the editor being rebuilt.
// ---------------------------------------------------------------------------------------------------------------------------

export const appHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--primary)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--success)" },
  { tag: tags.number, color: "var(--info)" },
  { tag: [tags.bool, tags.null, tags.keyword, tags.meta], color: "var(--warning)" },
  { tag: [tags.labelName, tags.typeName, tags.attributeValue], color: "var(--info)" },
  { tag: [tags.separator, tags.punctuation, tags.brace, tags.squareBracket], color: "var(--muted-foreground)" },
  { tag: [tags.lineComment, tags.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--destructive)" },
]);

const baseTheme: Record<string, Record<string, string>> = {
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    border: "1px solid var(--input)",
    borderRadius: "var(--radius-md)",
    fontSize: "12px",
  },
  "&.cm-focused": {
    outline: "none",
    borderColor: "var(--ring)",
    boxShadow: "0 0 0 3px color-mix(in srgb, var(--ring) 40%, transparent)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono), ui-monospace, monospace", lineHeight: "1.25rem", borderRadius: "inherit" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  ".cm-line": { padding: "0 12px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--primary) 30%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 55%, transparent)" },
  // Lines the caller marked as changed (`changedLines`): the same red look as the Detail Panel's old diff backdrop.
  ".cm-line.cm-changed-line, .cm-line.cm-changed-line.cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--destructive) 25%, transparent)" },
  ".cm-line.cm-removed-before": { boxShadow: "inset 0 2px 0 var(--destructive)" },
  ".cm-line.cm-removed-after": { boxShadow: "inset 0 -2px 0 var(--destructive)" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--accent)", color: "var(--foreground)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "2.5rem" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--primary) 22%, transparent)",
    outline: "1px solid var(--primary)",
  },
  "&.cm-focused .cm-nonmatchingBracket": { color: "var(--destructive)" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
  },
  ".cm-diagnostic": { fontFamily: "var(--font-sans), system-ui, sans-serif", fontSize: "12px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--destructive)" },
  // Schema violations are warnings; the schema's hover text and completion list use the same tokens.
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warning)" },
  ".cm6-json-schema-hover": { padding: "4px 8px", maxWidth: "24rem", fontFamily: "var(--font-sans), system-ui, sans-serif", fontSize: "12px" },
  // The description is plain text (see `plainHover`): its line breaks are shown, and a long unbroken word wraps instead of widening the tooltip.
  ".cm6-json-schema-hover--description": { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  ".cm6-json-schema-hover--code": { fontFamily: "var(--font-mono), ui-monospace, monospace", color: "var(--muted-foreground)", overflowWrap: "anywhere" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-foreground)" },
};

/** The theme without any height rule; two small ones add it. */
export const appTheme: Extension = EditorView.theme(baseTheme);
const fillTheme: Extension = EditorView.theme({ "&": { height: "100%" } });
const growTheme: Extension = EditorView.theme({ "&": { minHeight: "7.5rem", maxHeight: "24rem" } });

// ---------------------------------------------------------------------------------------------------------------------------
// Changed lines: an opt-in line decoration, driven by an effect so the editor is never rebuilt for it
// ---------------------------------------------------------------------------------------------------------------------------

export interface LineMarks {
  /** 1-based lines to paint with the changed background. */
  changed: readonly number[];
  /** 0-based line indexes before which a line was removed (`doc.lines` = after the last line): a red rule on that edge. */
  removedAt: readonly number[];
}
const NO_MARKS: LineMarks = { changed: [], removedAt: [] };

const setLineMarks = StateEffect.define<LineMarks>();

/** The marks to draw (normalised); the decorations are derived from them and the document, so they never go stale. */
const lineMarksField = StateField.define<LineMarks>({
  create: () => NO_MARKS,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setLineMarks)) return effect.value;
    return value;
  },
  provide: (field) =>
    EditorView.decorations.compute([field, "doc"], (state) => {
      const { changed, removedAt } = state.field(field);
      const classes = new Map<number, string[]>(); // 1-based line -> classes
      const add = (n: number, cls: string) => {
        if (n >= 1 && n <= state.doc.lines) classes.set(n, [...(classes.get(n) ?? []), cls]);
      };
      for (const n of changed) add(n, "cm-changed-line");
      for (const i of removedAt) {
        if (i >= state.doc.lines) add(state.doc.lines, "cm-removed-after");
        else add(i + 1, "cm-removed-before");
      }
      const builder = new RangeSetBuilder<Decoration>();
      for (const n of Array.from(classes.keys()).sort((a, b) => a - b)) {
        const from = state.doc.line(n).from;
        builder.add(from, from, Decoration.line({ class: (classes.get(n) ?? []).join(" ") }));
      }
      return builder.finish();
    }),
});

const uniqueAscending = (values: readonly number[], min: number): number[] =>
  Array.from(new Set(values.filter((n) => Number.isInteger(n) && n >= min))).sort((a, b) => a - b);

function normalizeMarks(marks: { changed: readonly number[]; removedAt?: readonly number[] }): LineMarks {
  return { changed: uniqueAscending(marks.changed, 1), removedAt: uniqueAscending(marks.removedAt ?? [], 0) };
}

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

// ---------------------------------------------------------------------------------------------------------------------------
// JSON lint
// ---------------------------------------------------------------------------------------------------------------------------

/** The lint markers of `text` as JSON: none for valid (or blank) text, else one error on the character the parser stopped at. */
export function lintJson(text: string): Diagnostic[] {
  const problem = jsonProblem(text);
  if (problem === null) return [];
  const end = text.trimEnd().length;
  // Text that stops short has nothing at the stop: mark the last character that is there.
  const from = problem.position >= end ? Math.max(0, end - 1) : problem.position;
  const to = Math.min(from + 1, Math.max(end, 1));
  return [{ from, to, severity: "error", message: problem.message, source: "JSON" }];
}

/**
 * Whether the lint pass that follows the last edit has finished, as `data-lint-state` on the editor's root (`.cm-editor`): "pending"
 * from the creation and from every edit until a pass has set its diagnostics (even an empty set: that is what a pass ends with),
 * "idle" after. The linter waits 250 ms after the last edit, so "nothing is flagged" right after an edit proves nothing; a browser
 * test waits for "idle" first and then asserts that no marker is there. (Swapping the schema re-lints without an edit and leaves the
 * state as it was: a test that changes the schema waits for the markers themselves.)
 */
const lintStateMarker = (): Extension => [
  ViewPlugin.define((view) => {
    view.dom.dataset.lintState = "pending";
    return {};
  }),
  EditorView.updateListener.of((update) => {
    const linted = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setDiagnosticsEffect)));
    if (linted) update.view.dom.dataset.lintState = "idle";
    else if (update.docChanged) update.view.dom.dataset.lintState = "pending";
  }),
];

// ---------------------------------------------------------------------------------------------------------------------------
// Schema support: `codemirror-json-schema`, loaded the first time an editor is given a schema (see `loadSchemaSupport`).
//
// What the library does, as verified against 0.8.1, and so what a caller has to hand it:
//  - It validates with JSON Schema DRAFT-04 rules (json-schema-library's `Draft04`). `if`/`then`/`else`, `contains`, `propertyNames`
//    and a numeric `exclusiveMinimum` are ignored: they never produce a warning, a document that breaks them looks fine.
//  - A LOCAL `$ref` that resolves inside the schema (`#`, `#/definitions/X`, `#/$defs/X`, recursive ones included) is followed and
//    checked like inline schema. A `$ref` it cannot resolve (a missing target, an absolute URL) is accepted silently, with no warning
//    and no error: that part of the schema is simply not checked. So callers must hand over a schema whose `$ref`s resolve inside it;
//    this file does not and cannot check that.
//  - Importing it starts a ~600 KB highlighter (shiki) for its markdown hovers. That is why nothing here imports it statically.
//  - Its hover, its completion info and its lint messages render markdown into innerHTML (a description with an image link would be
//    fetched; a backtick in a value breaks out of the code span in a message). Covered here: `plainHover` is its `formatHover`
//    (text only), `textOnlyCompletion` takes the non-text `info` off the completion options, and `schemaWarnings` drops its
//    `renderMessage`. Anything new from the library that takes a description or a message needs the same look.
//  - `jsonSchema()` would add a parse-error linter of its own next to ours; only the single pieces are used.
//  - With the `@lezer/json` of this repo (its tree has a node for each ":") the library's table of JSON pointers puts the value of
//    every property on the colon, and so every marker. `jsonDocument` gives it a correct table instead.
//  - It validates a best-effort repair of text that does not parse. `schemaWarnings` never asks for text that does not parse: the
//    one parse error is ours (`lintJson`).
// ---------------------------------------------------------------------------------------------------------------------------

type SchemaLibrary = typeof import("codemirror-json-schema");
/** The library's JSON Schema type (`JSONSchema7`), taken from its own signature so no other package is named for it. */
type SchemaArg = NonNullable<Parameters<SchemaLibrary["stateExtensions"]>[0]>;
type DocumentParser = NonNullable<NonNullable<Parameters<SchemaLibrary["jsonSchemaLinter"]>[0]>["jsonParser"]>;

interface SchemaSupport {
  library: SchemaLibrary;
  autocompletion: typeof import("@codemirror/autocomplete").autocompletion;
}

let supportLoading: Promise<SchemaSupport> | null = null;

/** The schema library and the completion UI it needs, loaded once; a failed load is forgotten so a later call can try again. */
function loadSchemaSupport(): Promise<SchemaSupport> {
  supportLoading ??= Promise.all([import("codemirror-json-schema"), import("@codemirror/autocomplete")])
    .then(([library, autocomplete]) => ({ library, autocompletion: autocomplete.autocompletion }))
    .catch((error: unknown) => {
      supportLoading = null;
      throw error;
    });
  return supportLoading;
}

interface PointerRange { keyFrom: number; keyTo: number; valueFrom: number; valueTo: number }

const JSON_VALUES = new Set(["String", "Number", "True", "False", "Null", "Object", "Array"]);

/** The name of a property as the validator writes it into a pointer: the string the quoted name stands for, not escaped further. */
function propertyKey(doc: Text, name: SyntaxNode): string {
  const quoted = doc.sliceString(name.from, name.to);
  try {
    return String(JSON.parse(quoted));
  } catch {
    return quoted;
  }
}

/** Records `node` under `pointer` (the name of its property, or itself in an array, is what a "key" marker points at), then its children. */
function collectPointers(doc: Text, node: SyntaxNode, pointer: string, key: { from: number; to: number }, into: Map<string, PointerRange>): void {
  into.set(pointer, { keyFrom: key.from, keyTo: key.to, valueFrom: node.from, valueTo: node.to });
  if (node.name === "Object") {
    for (let property = node.firstChild; property !== null; property = property.nextSibling) {
      const name = property.name === "Property" ? property.getChild("PropertyName") : null;
      const value = property.lastChild;
      if (name === null || value === null || !JSON_VALUES.has(value.name)) continue;
      collectPointers(doc, value, `${pointer}/${propertyKey(doc, name)}`, name, into);
    }
  } else if (node.name === "Array") {
    let index = 0;
    for (let item = node.firstChild; item !== null; item = item.nextSibling) {
      if (JSON_VALUES.has(item.name)) collectPointers(doc, item, `${pointer}/${index++}`, item, into);
    }
  }
}

/** Where every value of the JSON document is, by the JSON pointer the validator reports it under ("/lines/0/sku"; the root is not in it). */
function jsonPointers(state: EditorState): Map<string, PointerRange> {
  const pointers = new Map<string, PointerRange>();
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const root = tree.topNode.firstChild;
  if (root !== null && JSON_VALUES.has(root.name)) {
    collectPointers(state.doc, root, "", root, pointers);
    pointers.delete(""); // the root is not a property: a problem of the whole document is the library's to place
  }
  return pointers;
}

/** The library's document parser, with a table of pointers that is right (see above). */
const jsonDocument: DocumentParser = (state) => {
  let data: unknown = null;
  try {
    data = JSON.parse(state.doc.toString());
  } catch {
    // not JSON: `schemaWarnings` does not ask in that case, and the library skips a document without data
  }
  return { data, pointers: jsonPointers(state) };
};

/**
 * The lint source for a schema: the library's findings as WARNINGS (the text is valid JSON, a draft saves whatever the schema says)
 * and never an empty range (a problem of the whole document is marked on its first character). Nothing for text that does not parse.
 * Whatever goes wrong inside the library is no marker at all, never an exception into the editor.
 */
function schemaWarnings(library: SchemaLibrary): (view: EditorView) => Diagnostic[] {
  const lint = library.jsonSchemaLinter({ jsonParser: jsonDocument });
  return (view) => {
    try {
      if (jsonProblem(view.state.doc.toString()) !== null) return [];
      const length = view.state.doc.length;
      // Built field by field, NOT `...d`: the library puts a `renderMessage` on every diagnostic that sets innerHTML from markdown of the
      // message, and the message holds values and property names of the document (a backtick in one breaks out of the code span into
      // markup, an image link is fetched). Without a `renderMessage` @codemirror/lint shows the message as text.
      return lint(view).map((d): Diagnostic => ({
        from: d.from, to: d.to > d.from ? d.to : Math.min(d.from + 1, length), severity: "warning", message: d.message, source: typeof d.source === "string" ? d.source : undefined,
      }));
    } catch {
      return [];
    }
  };
}

/**
 * The hover text of a schema property, built from TEXT only. The library's own tooltip renders the description as markdown into
 * `innerHTML` (markdown-it, raw HTML off), and a description is whatever the schema's author wrote: an imported AsyncAPI document brings
 * third-party descriptions into entities, and `![x](https://third.party/p.png)` would make the browser fetch that URL as soon as someone
 * hovers. `textContent` shows the description and the type literally and parses nothing, so no element, image or link can come out of
 * it. (`jsonSchemaHover({ formatHover })` is the library's own option for this, 0.8.1; the class names are the library's, which the
 * theme styles.) Values that are not text (a schema may hold any JSON as a `description`) are left out. The description is shown as
 * written; the type line is the library's own markdown (`` `enum`: `a` or `b` ``), so its backticks are dropped.
 */
export function plainHover({ message, typeInfo }: { message?: unknown; typeInfo?: unknown }): HTMLElement {
  const block = (tag: "div" | "code", className: string, text: string): HTMLElement => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  };
  const root = document.createElement("div");
  root.className = "cm6-json-schema-hover";
  if (typeof message === "string" && message !== "") root.append(block("div", "cm6-json-schema-hover--description", message));
  // The library writes its type line as markdown (`enum`: `a` or `b``format`: date-time): drop the code spans' backticks, and keep a gap
  // where one span follows another (or follows a bare word) so "b" and "format" do not run together.
  const typeLine = typeof typeInfo === "string"
    ? typeInfo.replace(/`([^`]*)`/g, (_match, inner: string, offset: number, whole: string) => (offset > 0 && !/\s/.test(whole[offset - 1]) ? " " : "") + inner)
    : "";
  if (typeLine !== "") {
    const wrapper = document.createElement("div");
    wrapper.className = "cm6-json-schema-hover--code-wrapper";
    wrapper.append(block("code", "cm6-json-schema-hover--code", typeLine));
    root.append(wrapper);
  }
  return root;
}

/** One completion option as the editor may show it: `info` only if it is a string (shown as a text node), see `textOnlyCompletion`. */
function withTextInfo(option: Completion): Completion {
  if (option.info === undefined || typeof option.info === "string") return option;
  const copy = { ...option };
  delete copy.info;
  return copy;
}

type CompletionSource = (context: CompletionContext) => CompletionResult | never[];

/**
 * The library's completion source with every `info` that is not text taken away. For a property the library makes
 * `info: () => el("div", { inner: renderMarkdown(description) })`: running that function parses the description as markdown into
 * innerHTML, so an image link in it is fetched (a description is the schema author's; imported documents bring third-party ones in),
 * and the description cannot be had any other way (it is only in that function's closure). So those are dropped: labels, types, details,
 * `apply` and the rest of each option are untouched, the type stays in `detail`, and the hover shows the description as text
 * (`plainHover`). A string `info` (an enum or const value's description) stays: @codemirror/autocomplete shows a string as a text node.
 * Anything else (a schema's `description` may be any JSON, and a non-string would be called as a function) goes too.
 */
export function textOnlyCompletion(source: CompletionSource): CompletionSource {
  return (context) => {
    const result = source(context);
    return Array.isArray(result) ? result : { ...result, options: result.options.map(withTextInfo) }; // the library answers [] when it has nothing
  };
}

/** What a schema adds to an editor: the schema itself, its warnings, the hover text and the completion of its properties and values. */
function schemaExtensions({ library, autocompletion }: SchemaSupport, schema: SchemaArg): Extension[] {
  return [
    library.stateExtensions(schema),
    linter(schemaWarnings(library), { needsRefresh: library.handleRefresh, delay: 250 }),
    hoverTooltip(library.jsonSchemaHover({ formatHover: plainHover })),
    autocompletion(),
    jsonLanguage.data.of({ autocomplete: textOnlyCompletion(library.jsonCompletion()) }),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------------------------------------------------------

function contentAttributes(o: EditorOptions): Record<string, string> {
  const attributes: Record<string, string> = {
    id: o.id,
    // The editable node by test id too (the host div keeps `data-testid={id}`): e2e specs `fill` this one, a div they cannot fill.
    "data-testid": `${o.id}-content`,
    "aria-label": o.ariaLabel,
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
  };
  if (o.invalid) attributes["aria-invalid"] = "true";
  if (o.required) attributes["aria-required"] = "true";
  if (o.describedBy) attributes["aria-describedby"] = o.describedBy;
  if (o.readOnly || o.disabled) attributes["aria-readonly"] = "true";
  if (o.disabled) attributes["aria-disabled"] = "true";
  return attributes;
}

/**
 * The extensions for `options`. Tab: while the editor can be edited, Tab indents, and Esc then Tab (CodeMirror's built-in "tab focus
 * mode") moves focus on, so a keyboard user is never trapped; a read-only editor binds no Tab at all.
 */
export function buildExtensions(o: EditorOptions): Extension[] {
  const editable = !o.readOnly && !o.disabled;
  const extensions: Extension[] = [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    bracketMatching(),
    syntaxHighlighting(appHighlightStyle),
    o.language === "json" ? json() : yaml(),
    appTheme,
    o.fill ? fillTheme : growTheme,
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(!o.disabled),
    EditorView.contentAttributes.of(contentAttributes(o)),
  ];
  if (editable) {
    extensions.push(
      history(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    );
    if (o.placeholder) extensions.push(placeholder(o.placeholder));
    if (o.language === "json") extensions.push(linter((view) => lintJson(view.state.doc.toString()), { delay: 250 }), lintGutter(), lintStateMarker());
  } else {
    extensions.push(keymap.of(defaultKeymap));
  }
  return extensions;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------------------------------------------------------

export interface EditorHandle {
  readonly view: EditorView;
  /** Make the document `text`: nothing when it already is (the cursor stays), else the smallest edit (the cursor and scroll stay). */
  setValue: (text: string) => void;
  /** Apply new options; nothing when they are the same as the current ones. */
  reconfigure: (options: EditorOptions) => void;
  /**
   * Check the JSON text against `schema` (its `$ref`s must resolve inside it, see above), or stop checking with `null`. Resolves once it is applied, or once
   * it will never be: a newer call overtook it, the editor was destroyed, or the schema library could not be loaded (the editor then
   * simply has no schema support; a later call tries to load it again). It never rejects. Schemas are compared by content, so the same
   * schema as an equal new object does nothing. Only JSON editors that can be edited are meant to be given one.
   */
  setSchema: (schema: Record<string, unknown> | null) => Promise<void>;
  /** Mark 1-based `changed` lines with a background (the diff highlight) and a rule where lines were removed; empty clears. Nothing when same as now. */
  setLineMarks: (marks: { changed: readonly number[]; removedAt?: readonly number[] }) => void;
  /** Move focus into the editor, optionally selecting a range of the text. */
  focus: (selection?: { from: number; to: number }) => void;
  /** Ask for a re-measure, after the editor was shown or resized from outside. */
  measure: () => void;
  destroy: () => void;
}

export interface CreateEditorArgs {
  parent: HTMLElement;
  doc: string;
  options: EditorOptions;
  /** The user (not a `setValue`) changed the text. */
  onChange: (text: string) => void;
  onFocusChange: (focused: boolean) => void;
}

const sameOptions = (a: EditorOptions, b: EditorOptions) =>
  (Object.keys(a) as Array<keyof EditorOptions>).every((key) => a[key] === b[key]);

export function createEditor({ parent, doc, options, onChange, onFocusChange }: CreateEditorArgs): EditorHandle {
  const configuration = new Compartment();
  // Everything a schema adds lives in its own compartment, so it can be installed, swapped for another and removed on its own.
  const schemaSupport = new Compartment();
  let current = options;
  let destroyed = false;
  let heldSchema: string | null = null; // the `schemaKey` of the schema the editor holds now, null for none
  let schemaCalls = 0; // setSchema is asynchronous: only the newest call may apply its schema
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        configuration.of(buildExtensions(options)),
        schemaSupport.of([]),
        lineMarksField,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((t) => t.annotation(External) === true)) onChange(update.state.doc.toString());
          if (update.focusChanged) onFocusChange(update.view.hasFocus);
        }),
      ],
    }),
  });

  function removeSchema() {
    if (heldSchema === null || destroyed) return;
    view.dispatch({ effects: schemaSupport.reconfigure([]) });
    heldSchema = null;
    forceLinting(view); // the linters that remain re-run now, so the markers of the schema go at once
  }

  return {
    view,
    setValue(text) {
      const change = minimalChange(view.state.doc.toString(), normalizeLineBreaks(text));
      if (change === null) return;
      view.dispatch({ changes: change, annotations: External.of(true) });
    },
    reconfigure(next) {
      if (sameOptions(current, next)) return;
      current = next;
      view.dispatch({ effects: configuration.reconfigure(buildExtensions(next)) });
    },
    async setSchema(schema) {
      const call = ++schemaCalls;
      const key = schemaKey(schema);
      if (key === null || schema === null) {
        removeSchema();
        return;
      }
      if (key === heldSchema) return;
      let support: SchemaSupport;
      try {
        support = await loadSchemaSupport();
      } catch {
        return; // no schema support, and no complaint: the editor is as it was
      }
      if (call !== schemaCalls || destroyed) return;
      try {
        if (heldSchema === null) view.dispatch({ effects: schemaSupport.reconfigure(schemaExtensions(support, schema as SchemaArg)) });
        else support.library.updateSchema(view, schema as SchemaArg);
        heldSchema = key;
      } catch {
        return; // the library would not take this schema: an editor without it is better than a broken one
      }
      forceLinting(view); // lint with the new schema now, not after the delay
    },
    setLineMarks(marks) {
      if (destroyed) return;
      const next = normalizeMarks(marks);
      const held = view.state.field(lineMarksField);
      if (sameList(next.changed, held.changed) && sameList(next.removedAt, held.removedAt)) return;
      view.dispatch({ effects: setLineMarks.of(next) });
    },
    focus(selection) {
      if (selection) {
        const length = view.state.doc.length;
        view.dispatch({ selection: { anchor: Math.min(selection.from, length), head: Math.min(selection.to, length) } });
      }
      view.focus();
    },
    measure: () => view.requestMeasure(),
    destroy: () => {
      destroyed = true;
      view.destroy();
    },
  };
}
