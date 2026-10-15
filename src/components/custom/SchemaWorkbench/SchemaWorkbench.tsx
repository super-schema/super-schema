"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, ArrowLeft, FileCode, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { VISUAL_FORMATS } from "@/components/custom/VisualSchemaBuilder/registry";
import type { ImportFormat } from "@/lib/importers/types";
import {
  isWorkbenchFormat,
  serializeFormState,
  type FormState,
  type WorkbenchFormat,
} from "@/lib/schema-workbench/form-state";
import { parseToFormState } from "@/lib/schema-workbench/parse-to-form-state";
import {
  initialWorkbenchState,
  workbenchReducer,
} from "@/lib/schema-workbench/workbench-state";
import { DetailPanel } from "./DetailPanel";

type Mode = "drop" | "paste" | "form";

const ACCEPT = ".tsp,.avsc,.avro,.json,.yaml,.yml,.sql,.ddl,.proto";
const PARSE_DEBOUNCE_MS = 300;

const MODES: { id: Mode; label: string }[] = [
  { id: "drop", label: "Drop file" },
  { id: "paste", label: "Paste" },
  { id: "form", label: "Build form" },
];

export interface SchemaWorkbenchProps {
  /** Commit the current schema. `format` is set for form-built schemas; undefined → re-detect. */
  onCommit: (content: string, format: ImportFormat | undefined, filename?: string) => void;
  onBack: () => void;
  referenceTargets?: { id?: string; name: string }[];
  error?: string | null;
  isLoading?: boolean;
  /** Format the wizard detected for the last commit attempt. */
  detectedFormat?: string | null;
}

export function SchemaWorkbench({
  onCommit,
  onBack,
  referenceTargets = [],
  error,
  isLoading = false,
  detectedFormat,
}: SchemaWorkbenchProps) {
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState);
  const [mode, setMode] = useState<Mode>("drop");
  const [formFormat, setFormFormat] = useState<WorkbenchFormat>("json-schema");
  const [pasteText, setPasteText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  // A destructive action waiting for the user's confirmation.
  const [pending, setPending] = useState<{
    message: string;
    confirmLabel: string;
    run: () => void;
  } | null>(null);
  const [hydrate, setHydrate] = useState<{ nonce: number; state: FormState } | undefined>();

  // After a panel-driven hydrate the editor echoes the serialized state once
  // (null when it has no usable fields). `undefined` = no echo expected.
  const expectedEcho = useRef<{ text: string | null } | undefined>(undefined);
  const parseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nonce = useRef(0);

  useEffect(
    () => () => {
      if (parseTimer.current) clearTimeout(parseTimer.current);
    },
    []
  );

  // ── Import (drop / paste) ───────────────────────────────────────────

  const loadImport = useCallback(async (text: string, filename?: string) => {
    if (parseTimer.current) clearTimeout(parseTimer.current);
    // Loaded on demand: the detector pulls in `yaml`, which stays out of the wizard chunk.
    const { detectFormat } = await import("@/lib/importers/format-detector");
    const format = detectFormat(text, filename);
    setImportNotice(
      format
        ? null
        : "Could not detect the schema format. You can still edit the text, but import may fail."
    );
    setNotice(null);
    setHydrate(undefined);
    dispatch({ type: "loadImport", text, format, filename });
  }, []);

  const readFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => void loadImport(String(e.target?.result ?? ""), file.name);
      reader.readAsText(file);
    },
    [loadImport]
  );

  // ── Form ↔ panel handshake ──────────────────────────────────────────

  const handleFormContent = useCallback((text: string | null) => {
    const echo = expectedEcho.current;
    expectedEcho.current = undefined; // consume-once: a later identical text is a real edit
    // The editor echoes the state we just hydrated from the panel; keep what the
    // user typed instead of overwriting it with the normalised form.
    if (echo && echo.text === text) return;
    // A real form edit supersedes any panel edit still waiting to be parsed.
    if (parseTimer.current) clearTimeout(parseTimer.current);
    setNotice(null);
    dispatch({ type: "formChanged", text });
  }, []);

  const handlePanelChange = useCallback(
    (text: string) => {
      if (state.origin === "imported") {
        dispatch({ type: "panelEdited", text, mappable: true });
        return;
      }
      if (state.origin !== "form" || !state.format) return;

      const format = state.format;
      dispatch({ type: "panelEdited", text, mappable: true });
      if (parseTimer.current) clearTimeout(parseTimer.current);
      if (text.trim() === "") {
        setNotice(null);
        return;
      }
      parseTimer.current = setTimeout(() => {
        const result = parseToFormState(format, text);
        if (result.ok) {
          expectedEcho.current = { text: serializeFormState(result.state) };
          nonce.current += 1;
          setHydrate({ nonce: nonce.current, state: result.state });
          setNotice(null);
        } else {
          dispatch({ type: "panelEdited", text, mappable: false });
          setNotice(result.reason);
        }
      }, PARSE_DEBOUNCE_MS);
    },
    [state.origin, state.format]
  );

  // ── Mode switching ──────────────────────────────────────────────────

  const startForm = useCallback((format: WorkbenchFormat) => {
    if (parseTimer.current) clearTimeout(parseTimer.current);
    expectedEcho.current = undefined;
    setHydrate(undefined);
    setNotice(null);
    setImportNotice(null);
    setPending(null);
    setFormFormat(format);
    setMode("form");
    dispatch({ type: "startForm", format });
  }, []);

  function startOver() {
    if (parseTimer.current) clearTimeout(parseTimer.current);
    expectedEcho.current = undefined;
    setHydrate(undefined);
    setNotice(null);
    setImportNotice(null);
    setPasteText("");
    setPending(null);
    dispatch({ type: "clear" });
  }

  /** Work that would be lost if the form or the imported text were replaced. */
  const hasFormWork = state.origin === "form" && state.currentText.trim() !== "";
  const hasImportEdits =
    state.origin === "imported" && state.currentText !== state.baselineText;

  /** Replace the current schema with a new file / pasted text — confirm if that discards work. */
  function requestLoad(run: () => void) {
    if (hasFormWork || hasImportEdits) {
      setPending({
        message: hasFormWork
          ? "Loading a schema discards the form you built. Continue?"
          : "Loading a schema discards your edits to the imported one. Continue?",
        confirmLabel: "Discard & load",
        run,
      });
      return;
    }
    run();
  }

  /** Switch the Build-form format — confirm if that discards the form. */
  function requestFormat(format: WorkbenchFormat) {
    if (format === formFormat) return;
    if (hasFormWork) {
      setPending({
        message: "Switching format discards the form you built. Continue?",
        confirmLabel: "Discard form",
        run: () => startForm(format),
      });
      return;
    }
    startForm(format);
  }

  function selectMode(next: Mode) {
    if (next === "form") {
      if (state.origin === "imported" && state.currentText.trim()) {
        setPending({
          message: "Building with the form discards the imported schema. Continue?",
          confirmLabel: "Discard import",
          run: () => startForm(formFormat),
        });
        return;
      }
      if (state.origin !== "form") startForm(formFormat);
      else setMode("form");
      return;
    }
    setPending(null);
    setMode(next);
  }

  // ── Commit ──────────────────────────────────────────────────────────

  const canCommit = state.currentText.trim() !== "" && !isLoading;

  function commit() {
    if (!canCommit) return;
    if (state.origin === "form") {
      onCommit(state.currentText, state.format ?? undefined);
    } else {
      onCommit(state.currentText, undefined, state.filename);
    }
  }

  const activeFormat = VISUAL_FORMATS.find((f) => f.id === formFormat) ?? VISUAL_FORMATS[0];
  const Editor = activeFormat.Editor;
  const shownFormat = state.detectedFormat ?? detectedFormat ?? null;

  return (
    <div className="flex flex-col gap-space-4" data-testid="schema-workbench">
      <button
        onClick={onBack}
        className="flex items-center gap-1 self-start text-body-small text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div>
        <h3 className="text-heading-2 text-foreground mb-space-2">Import or Build Schema</h3>
        <p className="text-body-small text-muted-foreground">
          Drop a schema file, paste one, or build it field by field. The Detail Panel shows the
          schema and is editable. Form-built schemas stay in sync both ways; imported ones show
          your edits in red.
        </p>
      </div>

      {/* Source switcher */}
      <div className="flex items-center border border-border rounded-lg overflow-hidden self-start">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => selectMode(m.id)}
            aria-pressed={mode === m.id}
            className={cn(
              "px-space-3 py-1.5 text-body-small transition-colors",
              mode === m.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {pending && (
        <div
          role="alertdialog"
          data-testid="workbench-discard-confirm"
          className="flex items-center justify-between gap-space-3 p-space-3 rounded-lg border border-destructive/30 bg-destructive/5"
        >
          <span className="text-body-small text-foreground">{pending.message}</span>
          <span className="flex gap-space-2">
            <button
              type="button"
              onClick={() => {
                const { run } = pending;
                setPending(null);
                run();
              }}
              className="px-3 py-1 rounded-lg text-body-small bg-destructive text-destructive-foreground"
            >
              {pending.confirmLabel}
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="px-3 py-1 rounded-lg text-body-small bg-muted hover:bg-accent"
            >
              Cancel
            </button>
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-space-2 p-space-3 rounded-lg border border-destructive/30 bg-destructive/5">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-body-small text-destructive">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-space-4">
        {/* Input column */}
        <div className="min-w-0 flex flex-col gap-space-3">
          {state.origin === "imported" && mode !== "form" && (
            <div
              data-testid="workbench-import-summary"
              className="flex flex-wrap items-center gap-space-2 text-caption text-muted-foreground"
            >
              {state.filename && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-muted">
                  <FileCode className="w-3 h-3" />
                  {state.filename}
                </span>
              )}
              <span className="px-2 py-0.5 rounded border border-border">
                Format: {shownFormat ?? "unknown"}
              </span>
              <button
                type="button"
                onClick={() => dispatch({ type: "resetToBaseline" })}
                disabled={state.currentText === state.baselineText}
                className="px-2 py-0.5 rounded bg-muted hover:bg-accent disabled:opacity-40"
              >
                Reset to original
              </button>
              <button
                type="button"
                onClick={startOver}
                className="px-2 py-0.5 rounded bg-muted hover:bg-accent"
              >
                Start over
              </button>
            </div>
          )}
          {importNotice && mode !== "form" && (
            <div className="flex items-start gap-space-2 text-caption text-yellow-700 dark:text-yellow-400">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {importNotice}
            </div>
          )}

          {mode === "drop" && (
            <label
              data-testid="workbench-dropzone"
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setIsDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files[0];
                if (file) requestLoad(() => readFile(file));
              }}
              className={cn(
                "flex flex-col items-center justify-center gap-space-3 p-space-6 rounded-lg border-2 border-dashed cursor-pointer transition-all",
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-border/50 hover:border-primary/40 hover:bg-accent/10"
              )}
            >
              <Upload className={cn("w-8 h-8", isDragging ? "text-primary" : "text-muted-foreground")} />
              <div className="text-center">
                <p className="text-body-small text-foreground">
                  {isDragging ? "Drop file here" : "Click to browse or drag a file"}
                </p>
                <p className="text-caption text-muted-foreground mt-1">
                  .avsc, .sql, .ddl, .proto, .tsp, .json, .yaml, .yml
                </p>
              </div>
              <input
                data-testid="workbench-file-input"
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) requestLoad(() => readFile(file));
                  e.target.value = "";
                }}
              />
            </label>
          )}

          {mode === "paste" && (
            <>
              <textarea
                data-testid="workbench-paste-textarea"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                spellCheck={false}
                placeholder={`Paste your schema content here...

Example (Avro):
{
  "type": "record",
  "name": "Customer",
  "fields": [
    {"name": "id", "type": "long"},
    {"name": "name", "type": "string"}
  ]
}`}
                className="w-full h-64 bg-muted rounded-lg p-space-4 text-body-small text-foreground font-mono placeholder:text-muted-foreground/50 outline-none resize-y border border-border/50 focus:border-primary/40 transition-colors"
              />
              <button
                type="button"
                data-testid="workbench-load-button"
                disabled={!pasteText.trim()}
                onClick={() => requestLoad(() => void loadImport(pasteText))}
                className="self-start px-4 py-1.5 rounded-lg text-body-small bg-muted hover:bg-accent text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Load schema
              </button>
            </>
          )}

          {/* Kept mounted (just hidden) while another input is shown, so form state survives tab switches. */}
          {state.origin === "form" && (
            <div className={cn("flex flex-col gap-space-3", mode !== "form" && "hidden")}>
              <div className="flex items-center gap-space-2">
                <span className="text-caption text-muted-foreground">Format:</span>
                <div className="flex items-center border border-border rounded-lg overflow-hidden">
                  {VISUAL_FORMATS.map((format) => (
                    <button
                      key={format.id}
                      type="button"
                      disabled={!format.enabled || !isWorkbenchFormat(format.id)}
                      onClick={() => isWorkbenchFormat(format.id) && requestFormat(format.id)}
                      className={cn(
                        "px-space-3 py-1.5 text-body-small transition-colors",
                        format.id === formFormat
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                        !format.enabled && "opacity-40 cursor-not-allowed"
                      )}
                    >
                      {format.label}
                    </button>
                  ))}
                </div>
              </div>
              {Editor && (
                <Editor
                  key={formFormat}
                  defaultName="NewEntity"
                  referenceTargets={referenceTargets}
                  onContentChange={handleFormContent}
                  hydrate={hydrate}
                />
              )}
            </div>
          )}
        </div>

        {/* Detail panel column */}
        <div className="min-w-0 flex flex-col gap-space-2 lg:sticky lg:top-space-2 self-start w-full">
          <DetailPanel
            value={state.currentText}
            onChange={handlePanelChange}
            baseline={state.origin === "imported" ? state.baselineText : undefined}
            readOnly={state.origin === "none"}
            placeholder={
              state.origin === "form"
                ? "// Add a name and at least one field\n// to see the generated schema."
                : "// Drop a file, paste a schema, or build one with the form\n// to see it here."
            }
          />
          {state.origin === "form" && !state.formMappable && notice && (
            <div
              data-testid="workbench-unmappable"
              className="flex items-start gap-space-2 text-caption text-yellow-700 dark:text-yellow-400"
            >
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Can&apos;t map to the form: {notice}. The form is unchanged; keep editing as text.
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          data-testid="workbench-review-button"
          disabled={!canCommit}
          onClick={commit}
          className="px-4 py-1.5 rounded-lg text-body-small bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? "Parsing..." : "Review & Import"}
        </button>
      </div>
    </div>
  );
}
