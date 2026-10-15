"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, FileCode, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  getTypeSpecSourceAction,
  compileAndApplyTypeSpecSourceAction,
  type TypeSpecSourceSaveResult,
} from "../actions";

interface TypeSpecSourceTabProps {
  entityId: string;
  entityName: string;
  readOnly?: boolean;
  /** Called after a successful save (the draft changed). */
  onSaved?: () => void;
}

export function TypeSpecSourceTab({ entityId, entityName, readOnly, onSaved }: TypeSpecSourceTabProps) {
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [diagnostics, setDiagnostics] = useState<TypeSpecSourceSaveResult["diagnostics"]>([]);
  const [lastApplied, setLastApplied] = useState<TypeSpecSourceSaveResult["applied"] | null>(null);
  const [wasGenerated, setWasGenerated] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    const res = await getTypeSpecSourceAction(entityId);
    if ("error" in res) {
      toast.error(res.error);
      setIsLoading(false);
      return;
    }
    setSource(res.source);
    setSavedSource(res.source);
    setWasGenerated(res.generated);
    setIsLoading(false);
  }, [entityId]);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const isDirty = source !== savedSource;
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  async function handleSave() {
    setIsSaving(true);
    setDiagnostics([]);
    const result = await compileAndApplyTypeSpecSourceAction(entityId, source);
    setIsSaving(false);
    setDiagnostics(result.diagnostics);

    if (!result.success) {
      toast.error(result.error ?? "TypeSpec did not compile — see diagnostics below");
      return;
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
  }

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
          <Button variant="outline" size="sm" onClick={handleExport} className="gap-1.5">
            <Download className="w-3.5 h-3.5" />
            Export .tsp
          </Button>
          {!readOnly && (
            <Button size="sm" onClick={handleSave} disabled={isSaving || !isDirty} className="gap-1.5">
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {isSaving ? "Compiling…" : "Save"}
            </Button>
          )}
        </div>
      </div>

      <p className="text-caption text-muted-foreground">
        This is the entity&apos;s real, captured TypeSpec document — not a preview. Edits here
        compile through the real TypeSpec compiler and the governance decorator package
        before being applied; changes made through the visual field editor appear here too.
      </p>

      <textarea
        value={source}
        onChange={(e) => setSource(e.target.value)}
        readOnly={readOnly}
        spellCheck={false}
        className="w-full h-[480px] font-mono text-body-small bg-muted/30 border border-border rounded-md p-space-3 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
      />

      {diagnostics.length > 0 && (
        <div className="space-y-1">
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
        <p className="text-caption text-success">
          Compiled clean — {lastApplied.added} added, {lastApplied.updated} updated
          {lastApplied.removed.length > 0 ? `, ${lastApplied.removed.length} removed` : ""}.
        </p>
      )}
    </div>
  );
}
