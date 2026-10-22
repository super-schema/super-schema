"use client";

import { useDeferredValue, useMemo } from "react";
import { JsonEditor } from "@/features/events/builder/template/controls/JsonEditor";
import { diffLines, type LineDiff } from "@/lib/schema-workbench/line-diff";
import { editorKindFor } from "@/lib/schema-workbench/editor-kind";
import { HighlightedTextarea } from "./HighlightedTextarea";

interface DetailPanelProps {
  value: string;
  onChange: (value: string) => void;
  /** When set, lines that differ from this text are highlighted in red. */
  baseline?: string;
  readOnly?: boolean;
  placeholder?: string;
  /** Detected (imported) or chosen (form) format; picks the editor language. Null/undefined: sniffed from the text. */
  format?: string | null;
}

/** Past either limit the changed-line diff is skipped (the panel stays editable): it would stall typing on a huge schema. */
export const MAX_DIFF_CHARS = 1_500_000;
export const MAX_DIFF_LINES = 30_000;

/** The diff of `value` against `baseline`, or "skipped" when the text is too large to diff while typing. */
export function boundedDiff(baseline: string, value: string): LineDiff | "skipped" {
  if (baseline.length + value.length > MAX_DIFF_CHARS) return "skipped";
  let lines = 1;
  for (let i = value.indexOf("\n"); i !== -1; i = value.indexOf("\n", i + 1)) {
    if (++lines > MAX_DIFF_LINES) return "skipped";
  }
  return diffLines(baseline, value);
}

/**
 * Editable schema text, colour-coded: JSON and YAML in CodeMirror (line numbers, token colours, lint), Protobuf / TypeSpec / SQL in a
 * textarea over a coloured layer. With a `baseline` the changed lines get a red background so imported schemas show what the user
 * touched. The diff is computed from a deferred copy of the text, so typing is never blocked by it.
 */
export function DetailPanel({ value, onChange, baseline, readOnly, placeholder, format }: DetailPanelProps) {
  const deferred = useDeferredValue(value);
  const result = useMemo(
    () => (baseline !== undefined ? boundedDiff(baseline, deferred) : null),
    [baseline, deferred]
  );
  const skipped = result === "skipped";
  const diff = result === null || skipped ? null : result;
  const changedLines = useMemo(
    () => (diff ? diff.lines.flatMap((l, i) => (l.changed ? [i + 1] : [])) : undefined),
    [diff]
  );
  const removedAt = diff?.removedAt;
  const changed = changedLines?.length ?? 0;
  const removed = removedAt?.length ?? 0;
  const kind = editorKindFor(format, value);

  return (
    <div className="flex flex-col gap-space-1" data-testid="detail-panel">
      <div className="flex items-center justify-between">
        <span className="text-caption text-muted-foreground uppercase tracking-wider">
          Detail Panel
        </span>
        {diff && (changed > 0 || removed > 0) ? (
          <span data-testid="detail-panel-changes" className="text-caption text-destructive">
            {changed} changed
            {removed > 0 ? `, ${removed} removed` : ""} vs. original
          </span>
        ) : skipped ? (
          <span data-testid="detail-panel-diff-skipped" className="text-caption text-muted-foreground">
            Too large to highlight changes
          </span>
        ) : (
          <span className="text-caption text-muted-foreground">
            {baseline !== undefined ? "Unchanged" : "Live preview"}
          </span>
        )}
      </div>

      <div className="h-[420px]">
        {kind.kind === "codemirror" ? (
          <JsonEditor
            id="detail-panel-textarea"
            ariaLabel="Detail Panel schema text"
            value={value}
            onChange={onChange}
            language={kind.language}
            readOnly={readOnly}
            placeholder={placeholder}
            changedLines={changedLines}
            removedAt={removedAt}
            height="100%"
          />
        ) : (
          <HighlightedTextarea
            id="detail-panel-textarea"
            ariaLabel="Detail Panel schema text"
            value={value}
            onChange={onChange}
            highlight={kind.highlight}
            readOnly={readOnly}
            placeholder={placeholder}
            diff={diff}
            backdropTestId="detail-panel-backdrop"
            className="flex-1 min-h-0"
          />
        )}
      </div>
    </div>
  );
}
