"use client";

import { memo, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { highlightLine } from "@/lib/syntax-highlight";
import type { LineDiff } from "@/lib/schema-workbench/line-diff";

/** Above this the coloured layer is skipped (plain text, with a note): tokenising a huge input would stall typing. */
export const MAX_HIGHLIGHT_CHARS = 50_000;

/** Test seam: how many times a layer line was rendered (the layer is memoised per line, so an edit renders O(1) of them). */
export const renderStats = { lines: 0 };

const TEXT_CLS = "font-mono text-mono-small leading-5 p-space-3 whitespace-pre";

interface LineProps {
  text: string;
  highlight: "sql" | "code" | null;
  /** undefined: no diff active. */
  changed: boolean | undefined;
  removedBefore: boolean;
  removedAfter: boolean;
}

/** One line of the layer. Keyed by index and memoised on its primitives: an edit re-renders only the lines whose text or marks changed. */
const Line = memo(function Line({ text, highlight, changed, removedBefore, removedAfter }: LineProps) {
  renderStats.lines += 1;
  return (
    <div data-changed={changed === undefined ? undefined : changed ? "true" : "false"} className={cn("relative", changed && "bg-destructive/25")}>
      {highlight ? highlightLine(text || " ", highlight) : <span className="text-transparent">{text || " "}</span>}
      {removedBefore && <span data-testid="detail-panel-removed-marker" className="absolute inset-x-0 top-0 h-0.5 bg-destructive" />}
      {removedAfter && <span data-testid="detail-panel-removed-marker" className="absolute inset-x-0 bottom-0 h-0.5 bg-destructive" />}
    </div>
  );
});

interface HighlightedTextareaProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Token colours: SQL DDL, or the C-like highlighter used for Protobuf and TypeSpec. */
  highlight: "sql" | "code";
  readOnly?: boolean;
  placeholder?: string;
  /** Changed lines against a baseline: painted red behind the text (as marks only; the layer's text is always the live `value`). */
  diff?: LineDiff | null;
  /** Classes of the bordered box (it sets the height). */
  className?: string;
  backdropTestId?: string;
  /** Take the keyboard focus when mounted, caret at the end. Read once. */
  autoFocus?: boolean;
}

/**
 * An editable textarea for formats CodeMirror has no language for. The textarea's own text is transparent; a layer behind it paints
 * the same (live) text with token colours and the red changed-line backdrop, scrolled in step.
 */
export function HighlightedTextarea({
  id, value, onChange, ariaLabel, highlight, readOnly, placeholder, diff, className, backdropTestId, autoFocus = false,
}: HighlightedTextareaProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const colour = value.length <= MAX_HIGHLIGHT_CHARS;
  const showLayer = colour || Boolean(diff);
  const lines = showLayer ? value.split("\n") : [];
  const removed = new Set(diff?.removedAt ?? []);

  useEffect(() => {
    const area = areaRef.current;
    if (!autoFocus || area === null) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, on mount
  }, []);

  return (
    <div className="flex flex-col gap-space-1 h-full">
      <div
        className={cn(
          "relative rounded-lg border border-border bg-muted/50 overflow-hidden transition-colors",
          "focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/40",
          className
        )}
      >
        {showLayer && (
          <div
            ref={layerRef}
            aria-hidden
            data-testid={backdropTestId}
            data-highlight={colour ? highlight : "none"}
            className={`absolute inset-0 overflow-hidden pointer-events-none ${TEXT_CLS}`}
          >
            {lines.map((text, i) => (
              <Line
                key={i}
                text={text}
                highlight={colour ? highlight : null}
                changed={diff ? (i < diff.lines.length ? diff.lines[i].changed : false) : undefined}
                removedBefore={removed.has(i)}
                removedAfter={i === lines.length - 1 && removed.has(lines.length)}
              />
            ))}
          </div>
        )}
        <textarea
          ref={areaRef}
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
            if (layerRef.current) {
              layerRef.current.scrollTop = e.currentTarget.scrollTop;
              layerRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
          className={cn(
            "absolute inset-0 w-full h-full resize-none bg-transparent outline-none overflow-auto caret-foreground placeholder:text-muted-foreground/50",
            colour ? "text-transparent" : "text-foreground",
            TEXT_CLS
          )}
        />
      </div>
      {!colour && (
        <p data-testid={`${id}-colors-off`} className="text-caption text-muted-foreground">
          Syntax colors are off for very large inputs
        </p>
      )}
    </div>
  );
}
