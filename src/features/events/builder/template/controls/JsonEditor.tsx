"use client";

// src/features/events/builder/template/controls/JsonEditor.tsx
// A JSON / YAML text editor: CodeMirror 6 with line numbers, bracket matching, undo history, highlighting in the app's colours and
// JSON lint markers; or, until CodeMirror has loaded (and wherever it cannot run, such as jsdom), a plain textarea with the very same
// props. CodeMirror is loaded with `import()` from an effect, so it is neither in the first bundle nor needed for server rendering.
// The CodeMirror code itself is in `codemirror-setup.ts`; no other module imports `@codemirror/*` (a test checks that).
import { useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { EditorHandle, EditorLanguage, EditorOptions } from "./codemirror-setup";
import { jsonProblem } from "./editor-text";

export type { EditorLanguage } from "./codemirror-setup";

export interface JsonEditorProps {
  /** Id of the element that takes the keyboard (the textarea, or CodeMirror's editable area) and its `data-testid`. */
  id: string;
  /** The text. A new value replaces the document (keeping the cursor when the text is the same); typing reports through `onChange`. */
  value: string;
  /** The text after every edit by the user. Not called for a change of `value`. Not needed when `readOnly`. */
  onChange?: (text: string) => void;
  language: EditorLanguage;
  /** Selectable and focusable, but not editable. */
  readOnly?: boolean;
  /** The accessible name. */
  ariaLabel: string;
  /**
   * A JSON Schema to validate the text against. Reserved and currently ignored: it needs the optional `codemirror-json-schema`, which
   * is not installed (it pulls in shiki, markdown-it and json-schema-library, none of which this repo has).
   */
  schema?: unknown;
  /** A CSS height for the editor to fill (`"100%"`, 240); without one it grows with the text, between a minimum and a maximum. */
  height?: string | number;
  /** The parse problem of JSON text (with line and column), or null when there is none. Reported when it changes. */
  onErrorChange?: (message: string | null) => void;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  /** Space-separated ids of the help text and errors of the field this edits. */
  describedBy?: string;
  placeholder?: string;
}

type Setup = typeof import("./codemirror-setup");
let setupLoading: Promise<Setup> | null = null;

/** The CodeMirror code, loaded once for the page; a failed load is forgotten so a later editor can try again. */
function loadSetup(): Promise<Setup> {
  setupLoading ??= import("./codemirror-setup").catch((error: unknown) => {
    setupLoading = null;
    throw error;
  });
  return setupLoading;
}

/**
 * CodeMirror measures text with `Range.getClientRects`, which every browser has and jsdom does not: where it is missing the
 * editor stays on the textarea. (Tests that mount the real editor install a stand-in first.)
 */
export function codeMirrorSupported(): boolean {
  return typeof document !== "undefined" && typeof Range !== "undefined" && typeof Range.prototype.getClientRects === "function";
}

export function JsonEditor({
  id, value, onChange, language, readOnly = false, ariaLabel, height, onErrorChange,
  disabled = false, required = false, invalid = false, describedBy, placeholder,
}: JsonEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const pendingFocus = useRef<{ from: number; to: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [focused, setFocused] = useState(false);

  const hintId = `${id}-tab-hint`;
  const editable = !readOnly && !disabled;
  const fill = height !== undefined;
  const editorDescribedBy = [describedBy, editable ? hintId : undefined].filter(Boolean).join(" ") || undefined;
  const options = useMemo<EditorOptions>(
    () => ({ language, readOnly, disabled, fill, id, ariaLabel, invalid, required, describedBy: editorDescribedBy, placeholder }),
    [language, readOnly, disabled, fill, id, ariaLabel, invalid, required, editorDescribedBy, placeholder]
  );

  // What the load effect (which runs once) needs to read when CodeMirror arrives: the newest of everything.
  const latest = useRef({ value, onChange, onErrorChange, options });
  useEffect(() => {
    latest.current = { value, onChange, onErrorChange, options };
  });

  // Load CodeMirror, then build the editor on the document as it is by then; destroy it when this goes away.
  useEffect(() => {
    if (!codeMirrorSupported()) return undefined;
    let cancelled = false;
    let handle: EditorHandle | null = null;
    loadSetup()
      .then((setup) => {
        const host = hostRef.current;
        if (cancelled || host === null) return;
        const area = areaRef.current;
        const hadFocus = area !== null && document.activeElement === area;
        handle = setup.createEditor({
          parent: host,
          doc: latest.current.value,
          options: latest.current.options,
          onChange: (text) => latest.current.onChange?.(text),
          onFocusChange: setFocused,
        });
        handleRef.current = handle;
        // A user who was typing in the textarea carries on in the editor, at the same place.
        pendingFocus.current = hadFocus ? { from: area.selectionStart, to: area.selectionEnd } : null;
        setReady(true);
      })
      .catch(() => {
        // CodeMirror could not be loaded or started: the textarea stays, and it works.
        if (handle !== null) {
          handle.destroy();
          handle = null;
        }
      });
    return () => {
      cancelled = true;
      if (handle !== null) handle.destroy();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, []);

  // The editor was just shown (it was hidden behind the textarea while loading).
  useEffect(() => {
    if (!ready) return;
    const handle = handleRef.current;
    if (handle === null) return;
    handle.measure();
    if (pendingFocus.current !== null) {
      handle.focus(pendingFocus.current);
      pendingFocus.current = null;
    }
  }, [ready]);

  useEffect(() => {
    handleRef.current?.setValue(value);
  }, [value, ready]);

  useEffect(() => {
    handleRef.current?.reconfigure(options);
  }, [options, ready]);

  // The parse problem of JSON text, reported when it changes. Computed here, not by the lint source, so it is the same with or without
  // CodeMirror and does not wait for the linter's delay.
  const wantsProblems = onErrorChange !== undefined && language === "json";
  const problem = useMemo(() => (wantsProblems ? (jsonProblem(value)?.message ?? null) : null), [wantsProblems, value]);
  const reported = useRef<string | null | undefined>(undefined);
  const hasErrorCallback = onErrorChange !== undefined;
  useEffect(() => {
    if (!hasErrorCallback || reported.current === problem) return;
    reported.current = problem;
    latest.current.onErrorChange?.(problem);
  }, [problem, hasErrorCallback]);

  return (
    <div
      data-testid={`${id}-editor`} data-editor={ready ? "codemirror" : "textarea"} data-language={language}
      className="relative" style={fill ? { height } : undefined}
    >
      {!ready && (
        <Textarea
          ref={areaRef} id={id} data-testid={id} value={value} readOnly={readOnly} disabled={disabled} placeholder={placeholder}
          spellCheck={false} wrap={readOnly ? "off" : undefined} aria-label={ariaLabel}
          aria-required={required || undefined} aria-invalid={invalid || undefined} aria-describedby={describedBy}
          onChange={(e) => onChange?.(e.target.value)}
          className={cn("font-mono text-caption", fill ? "field-sizing-fixed h-full resize-none" : "min-h-[7.5rem]", readOnly && "whitespace-pre")}
        />
      )}
      <div ref={hostRef} data-testid={ready ? id : undefined} className={ready ? "h-full" : "hidden"} />
      {ready && editable && (
        <p
          id={hintId} data-testid={hintId} data-visible={focused}
          className={cn(
            focused
              ? "pointer-events-none absolute right-2 bottom-1 z-10 rounded-md bg-popover px-1.5 py-0.5 text-caption text-muted-foreground shadow-sm ring-1 ring-border"
              : "sr-only"
          )}
        >
          Press Esc, then Tab to leave the editor
        </p>
      )}
    </div>
  );
}
