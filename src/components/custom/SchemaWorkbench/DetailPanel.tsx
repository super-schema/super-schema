"use client";

import { useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { diffLines } from "@/lib/schema-workbench/line-diff";

interface DetailPanelProps {
  value: string;
  onChange: (value: string) => void;
  /** When set, lines that differ from this text are highlighted in red. */
  baseline?: string;
  readOnly?: boolean;
  placeholder?: string;
}

const TEXT_CLS = "font-mono text-mono-small leading-5 p-space-3 whitespace-pre";

/**
 * Editable schema text. With a `baseline` it paints changed lines red behind
 * the (transparent) textarea so imported schemas show what the user touched.
 */
export function DetailPanel({ value, onChange, baseline, readOnly, placeholder }: DetailPanelProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const diff = useMemo(
    () => (baseline !== undefined ? diffLines(baseline, value) : null),
    [baseline, value]
  );
  const removedBefore = useMemo(() => new Set(diff?.removedAt ?? []), [diff]);
  const changed = diff ? diff.lines.filter((l) => l.changed).length : 0;
  const removed = diff ? diff.removedAt.length : 0;

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
        ) : (
          <span className="text-caption text-muted-foreground">
            {baseline !== undefined ? "Unchanged" : "Live preview"}
          </span>
        )}
      </div>

      <div className="relative rounded-lg border border-border bg-muted/50 overflow-hidden h-[420px]">
        {diff && (
          <div
            ref={backdropRef}
            aria-hidden
            data-testid="detail-panel-backdrop"
            className={`absolute inset-0 overflow-hidden pointer-events-none text-transparent ${TEXT_CLS}`}
          >
            {diff.lines.map((line, i) => (
              <div
                key={i}
                data-changed={line.changed ? "true" : "false"}
                className={cn("relative", line.changed && "bg-destructive/25")}
              >
                {line.text || " "}
                {removedBefore.has(i) && (
                  <span
                    data-testid="detail-panel-removed-marker"
                    className="absolute inset-x-0 top-0 h-0.5 bg-destructive"
                  />
                )}
                {i === diff.lines.length - 1 && removedBefore.has(diff.lines.length) && (
                  <span
                    data-testid="detail-panel-removed-marker"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-destructive"
                  />
                )}
              </div>
            ))}
          </div>
        )}
        <textarea
          data-testid="detail-panel-textarea"
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          spellCheck={false}
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (backdropRef.current) {
              backdropRef.current.scrollTop = e.currentTarget.scrollTop;
              backdropRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
          className={`relative w-full h-full resize-none bg-transparent text-foreground outline-none overflow-auto ${TEXT_CLS}`}
        />
      </div>
    </div>
  );
}
