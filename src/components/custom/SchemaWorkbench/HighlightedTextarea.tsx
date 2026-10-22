"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";
import { highlightLine } from "@/lib/syntax-highlight";
import type { LineDiff } from "@/lib/schema-workbench/line-diff";

/** Above this the coloured layer is skipped (plain text): tokenising every line on every keystroke would stall a huge paste. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

const TEXT_CLS = "font-mono text-mono-small leading-5 p-space-3 whitespace-pre";

interface HighlightedTextareaProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Token colours: SQL DDL, or the C-like highlighter used for Protobuf and TypeSpec. */
  highlight: "sql" | "code";
  readOnly?: boolean;
  placeholder?: string;
  /** Changed lines against a baseline: painted red behind the text. */
  diff?: LineDiff | null;
  /** Classes of the bordered box (it sets the height). */
  className?: string;
  backdropTestId?: string;
}

/**
 * An editable textarea for formats CodeMirror has no language for. The textarea's own text is transparent; a layer behind it paints
 * the same text with token colours (and the red changed-line backdrop), scrolled in step.
 */
export function HighlightedTextarea({
  id, value, onChange, ariaLabel, highlight, readOnly, placeholder, diff, className, backdropTestId,
}: HighlightedTextareaProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const colour = value.length <= MAX_HIGHLIGHT_CHARS;
  const removedBefore = new Set(diff?.removedAt ?? []);
  const lines = diff ? diff.lines.map((l) => l.text) : value.split("\n");
  const showLayer = colour || Boolean(diff);

  return (
    <div className={cn("relative rounded-lg border border-border bg-muted/50 overflow-hidden", className)}>
      {showLayer && (
        <div
          ref={backdropRef}
          aria-hidden
          data-testid={backdropTestId}
          data-highlight={colour ? highlight : "none"}
          className={`absolute inset-0 overflow-hidden pointer-events-none ${TEXT_CLS}`}
        >
          {lines.map((text, i) => {
            const changed = diff?.lines[i]?.changed ?? false;
            return (
              <div key={i} data-changed={diff ? (changed ? "true" : "false") : undefined} className={cn("relative", changed && "bg-destructive/25")}>
                {colour ? highlightLine(text || " ", highlight) : <span className="text-transparent">{text || " "}</span>}
                {removedBefore.has(i) && (
                  <span data-testid="detail-panel-removed-marker" className="absolute inset-x-0 top-0 h-0.5 bg-destructive" />
                )}
                {diff && i === lines.length - 1 && removedBefore.has(lines.length) && (
                  <span data-testid="detail-panel-removed-marker" className="absolute inset-x-0 bottom-0 h-0.5 bg-destructive" />
                )}
              </div>
            );
          })}
        </div>
      )}
      <textarea
        id={id}
        data-testid={id}
        aria-label={ariaLabel}
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
        className={cn(
          "relative w-full h-full resize-none bg-transparent outline-none overflow-auto caret-foreground placeholder:text-muted-foreground/50",
          showLayer && colour ? "text-transparent" : "text-foreground",
          TEXT_CLS
        )}
      />
    </div>
  );
}
