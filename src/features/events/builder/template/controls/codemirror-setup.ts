// src/features/events/builder/template/controls/codemirror-setup.ts
// The CodeMirror 6 side of `JsonEditor`: extensions, theme, highlight style, JSON lint source and the small handle the React wrapper
// drives. Together with `JsonEditor.tsx` this is the ONLY file that imports `@codemirror/*` or `@lezer/*` (a test enforces it).
// It is loaded on demand with `import()` from `JsonEditor.tsx`, so none of it is in the first bundle of a page.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, placeholder,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { jsonProblem, minimalChange, normalizeLineBreaks } from "./editor-text";

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
};

/** The theme without any height rule; two small ones add it. */
export const appTheme: Extension = EditorView.theme(baseTheme);
const fillTheme: Extension = EditorView.theme({ "&": { height: "100%" } });
const growTheme: Extension = EditorView.theme({ "&": { minHeight: "7.5rem", maxHeight: "24rem" } });

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

// ---------------------------------------------------------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------------------------------------------------------

function contentAttributes(o: EditorOptions): Record<string, string> {
  const attributes: Record<string, string> = {
    id: o.id,
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
    if (o.language === "json") extensions.push(linter((view) => lintJson(view.state.doc.toString()), { delay: 250 }), lintGutter());
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
  let current = options;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        configuration.of(buildExtensions(options)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((t) => t.annotation(External) === true)) onChange(update.state.doc.toString());
          if (update.focusChanged) onFocusChange(update.view.hasFocus);
        }),
      ],
    }),
  });
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
    focus(selection) {
      if (selection) {
        const length = view.state.doc.length;
        view.dispatch({ selection: { anchor: Math.min(selection.from, length), head: Math.min(selection.to, length) } });
      }
      view.focus();
    },
    measure: () => view.requestMeasure(),
    destroy: () => view.destroy(),
  };
}
