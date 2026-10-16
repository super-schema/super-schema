"use client";

// src/features/events/event-page/EventPreview.tsx
// The Docs tab: the rendered documentation of the current (unsaved) draft in the sandboxed iframe, and the diagnostics of its
// emission. (The AsyncAPI source of the same draft is the live Code panel in the shell's right Detail Panel.)
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AsyncApiPreview } from "@/features/events/event-specs/AsyncApiPreview";
import { DiagnosticsList } from "@/features/events/event-specs/DiagnosticsList";
import type { EventPreviewState } from "./use-event-preview";

/**
 * Presentational: the page owns `useEventPreview` (so the answer survives leaving and reopening the tab) and passes it down.
 * `blocked` = the draft does not parse on the client, so nothing was sent. Diagnostics are ONE list: a diagnostic carries no
 * hint whether its pointer is into the draft (render / resolve problems) or into the emitted document (assembler, validator).
 */
export function EventPreview({ title, state, blocked, onBackToDesign }: {
  title: string;
  state: Pick<EventPreviewState, "output" | "loading" | "error" | "refresh">;
  blocked: boolean;
  onBackToDesign: () => void;
}) {
  if (blocked) {
    return (
      <div data-testid="event-preview" className="space-y-space-3 rounded-lg border border-dashed border-border p-space-6 text-center">
        <p data-testid="preview-blocked" className="text-heading-3 text-foreground">Fix the problems in Design first</p>
        <p className="text-body-small text-muted-foreground">The docs are built from your draft, and the draft has problems. They are marked in the outline.</p>
        <Button type="button" variant="outline" onClick={onBackToDesign} data-testid="preview-blocked-back">Back to Design</Button>
      </div>
    );
  }

  const { output, loading, error, refresh } = state;
  return (
    <div data-testid="event-preview" className="space-y-space-6">
      <div className="flex items-center justify-between gap-space-3">
        <p role="status" data-testid="preview-status" className="flex items-center gap-space-2 text-body-small text-muted-foreground">
          {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {loading ? "Rendering docs…" : ""}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={refresh} data-testid="preview-refresh" className="gap-1.5">
          <RefreshCw className="size-4" aria-hidden="true" /> Refresh
        </Button>
      </div>

      {error ? (
        <div role="alert" data-testid="preview-error" className="rounded-lg border border-destructive/30 bg-destructive/5 p-space-3 text-body-small text-destructive">
          <p>{error}</p>
          <p className="text-muted-foreground">Use Refresh to try again.</p>
        </div>
      ) : output === null ? null : (
        <>
          {output.document === null ? (
            <p data-testid="preview-empty" className="rounded-lg border border-dashed border-border p-space-6 text-center text-body-small text-muted-foreground">
              The AsyncAPI document could not be built from this draft. The diagnostics below say why.
            </p>
          ) : (
            <AsyncApiPreview document={output.document} title={title} />
          )}
          <section aria-labelledby="preview-diagnostics-heading" className="space-y-space-3">
            <h2 id="preview-diagnostics-heading" className="text-heading-3 text-foreground">Diagnostics</h2>
            <p className="text-caption text-muted-foreground">A pointer refers either to your draft or to the generated AsyncAPI document.</p>
            <DiagnosticsList diagnostics={output.diagnostics} unpublishedMessages={[]} />
          </section>
        </>
      )}
    </div>
  );
}
