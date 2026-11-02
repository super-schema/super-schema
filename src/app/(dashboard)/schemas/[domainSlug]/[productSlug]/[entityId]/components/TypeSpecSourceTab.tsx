"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { Loader2, Save, FileCode, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  getTypeSpecSourceAction,
  compileAndApplyTypeSpecSourceAction,
  type TypeSpecSourceSaveResult,
} from "../actions";
import { useReferencePick } from "./useReferencePick";
import { errorMessage } from "@/lib/error-message";

interface TypeSpecSourceTabProps {
  entityId: string;
  entityName: string;
  readOnly?: boolean;
  /** Called after a successful save (the draft changed). */
  onSaved?: () => void;
  /** Reports whether the source has edits that are not saved (the page guards them). Called with false when this tab goes away. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Saves the source for the page's leave guard; resolves true when it was applied. */
  saveRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  /** Drops the unsaved edits: the source goes back to the saved text. */
  discardRef?: MutableRefObject<(() => void) | null>;
}

export function TypeSpecSourceTab({ entityId, entityName, readOnly, onSaved, onDirtyChange, saveRef, discardRef }: TypeSpecSourceTabProps) {
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [diagnostics, setDiagnostics] = useState<TypeSpecSourceSaveResult["diagnostics"]>([]);
  const [lastApplied, setLastApplied] = useState<TypeSpecSourceSaveResult["applied"] | null>(null);
  const [wasGenerated, setWasGenerated] = useState(false);

  // A field typed with a name that several entities share is asked about (needsReference). The text may add that field, so there is no
  // row to save the pick on: it is kept here, by field name, and goes with the retry of the save (the server accepts it only when it is
  // one of the entities the name matches).
  const picks = useRef<Record<string, string>>({});
  // The save in progress, if any: the page's guard and the Save button share it.
  const saveAttempt = useRef<Promise<boolean> | null>(null);
  const { resolveReferences, dialog: referenceDialog } = useReferencePick({
    savePick: (request, picked) => {
      if (!picked.entityId) return "This entity has no id, so the choice cannot be saved.";
      picks.current = { ...picks.current, [request.field]: picked.entityId };
      return undefined;
    },
  });

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await getTypeSpecSourceAction(entityId);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setSource(res.source);
      setSavedSource(res.source);
      setWasGenerated(res.generated);
    } catch (error) {
      // The spinner must end whatever the action did, or the tab shows "Compiling current fields…" for the rest of the session.
      toast.error(`Could not load the TypeSpec source: ${errorMessage(error)}`);
    } finally {
      setIsLoading(false);
    }
  }, [entityId]);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    void load();
  }, [load]);

  const isDirty = source !== savedSource;
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  // The page's guard asks about an unsaved source. Leaving this tab takes the source with it, so the page stops guarding it then. (Layout
  // effects: the guard sees an edit before the next event can be handled.)
  useLayoutEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);
  useLayoutEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  /** Saves the source through the compiler. True when it was applied. A save already running is the one answered. */
  function save(): Promise<boolean> {
    if (saveAttempt.current) return saveAttempt.current;
    const attempt = (async (): Promise<boolean> => {
      setIsSaving(true);
      setDiagnostics([]);
      picks.current = {};
      try {
        // `needsReference` is looked at before the result's own error: the dialog asks, the pick is kept, and the save runs once more.
        const result = await resolveReferences(() => compileAndApplyTypeSpecSourceAction(entityId, source, picks.current));
        // Cancelled: nothing was saved and nothing went wrong.
        if (result === null) return false;
        setDiagnostics(result.diagnostics);

        if (!result.success) {
          toast.error(result.error ?? "TypeSpec did not compile — see diagnostics below");
          return false;
        }

        setSavedSource(source);
        setLastApplied(result.applied ?? null);
        setWasGenerated(false);
        onSaved?.();
        const { added = 0, updated = 0, removed = [] } = result.applied ?? {};
        toast.success(
          `TypeSpec compiled and applied — ${added} added, ${updated} updated${
            removed.length > 0 ? `, ${removed.length} removed` : ""
          }`
        );
        return true;
      } catch (error) {
        // A rejected save must not leave Save stuck on "Compiling…": the button comes back, and the source stays as typed.
        toast.error(`Could not save the TypeSpec source: ${errorMessage(error)}`);
        return false;
      } finally {
        setIsSaving(false);
        saveAttempt.current = null;
      }
    })();
    saveAttempt.current = attempt;
    return attempt;
  }

  function discardSource() {
    setSource(savedSource);
  }

  // The page's guard saves and discards through these refs. They always hold this render's functions.
  useLayoutEffect(() => {
    if (saveRef) saveRef.current = save;
    if (discardRef) discardRef.current = discardSource;
  });
  useLayoutEffect(() => () => {
    if (saveRef) saveRef.current = null;
    if (discardRef) discardRef.current = null;
  }, [saveRef, discardRef]);

  function handleExport() {
    const blob = new Blob([savedSource], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${entityName}.tsp`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-space-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Compiling current fields to TypeSpec…
      </div>
    );
  }

  return (
    <div className="space-y-space-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileCode className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-heading-2 text-foreground">TypeSpec Source</h2>
          {wasGenerated && (
            <span className="text-caption text-muted-foreground/60">
              (generated from current fields — not yet saved as source)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExport} className="gap-1.5" data-testid="typespec-export">
            <Download className="w-3.5 h-3.5" />
            Export .tsp
          </Button>
          {!readOnly && (
            <Button size="sm" onClick={() => void save()} disabled={isSaving || !isDirty} className="gap-1.5" data-testid="typespec-save">
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {isSaving ? "Compiling…" : "Save"}
            </Button>
          )}
        </div>
      </div>

      <p className="text-caption text-muted-foreground">
        This is the entity&apos;s real, captured TypeSpec document — not a preview. Edits here
        compile through the real TypeSpec compiler and the governance decorator package
        before being applied; changes made through the visual field editor appear here too. A
        field can be typed with the name of another entity of this tenant (<code>Address</code>, or
        <code> Domain.Product.Entity</code> to say which one when several share a name); it is saved
        as a reference to that entity.
      </p>

      <textarea
        data-testid="typespec-source-textarea"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        readOnly={readOnly}
        spellCheck={false}
        className="w-full h-[480px] font-mono text-body-small bg-muted/30 border border-border rounded-md p-space-3 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
      />

      {diagnostics.length > 0 && (
        <div className="space-y-1" data-testid="typespec-diagnostics">
          {errors.map((d, i) => (
            <div key={`e${i}`} className="text-body-small text-destructive flex gap-2">
              <span className="font-mono text-caption shrink-0">[{d.code}]</span>
              <span>{d.message}</span>
            </div>
          ))}
          {warnings.map((d, i) => (
            <div key={`w${i}`} className="text-body-small text-warning flex gap-2">
              <span className="font-mono text-caption shrink-0">[{d.code}]</span>
              <span>{d.message}</span>
            </div>
          ))}
        </div>
      )}

      {lastApplied && diagnostics.length === 0 && (
        <p className="text-caption text-success" data-testid="typespec-compiled-clean">
          Compiled clean — {lastApplied.added} added, {lastApplied.updated} updated
          {lastApplied.removed.length > 0 ? `, ${lastApplied.removed.length} removed` : ""}.
        </p>
      )}

      {referenceDialog}
    </div>
  );
}
