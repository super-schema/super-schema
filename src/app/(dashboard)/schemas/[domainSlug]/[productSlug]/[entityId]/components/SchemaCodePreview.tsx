"use client";

import { useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { useTransientFlag } from "@/hooks/useTransientFlag";
import { highlightLine } from "@/lib/syntax-highlight";

interface SchemaCodePreviewProps {
  code: string;
  language?: string;
  onCopy: () => void;
  /** The caption in the header: "Preview" unless the code is one file of a set (then its path). */
  title?: string;
}

export function SchemaCodePreview({ code, language = "sql", onCopy, title = "Preview" }: SchemaCodePreviewProps) {
  const [copied, flashCopied] = useTransientFlag(2000);
  const lines = code.split("\n");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    flashCopied();
    onCopy();
  }, [code, onCopy, flashCopied]);

  return (
    <div data-testid="schema-code-preview" className="relative rounded-md border border-border/50 bg-muted/20 overflow-hidden">
      <div className="flex items-center justify-between px-space-3 py-space-1 bg-muted/30 border-b border-border/50">
        <span className={`text-caption text-muted-foreground truncate ${title === "Preview" ? "" : "font-mono"}`} title={title}>{title}</span>
        <button
          type="button"
          data-testid="schema-code-copy"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="p-space-3 text-caption font-mono text-foreground overflow-x-auto max-h-80 overflow-y-auto">
        <code>
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span className="inline-block w-8 text-right pr-3 text-muted-foreground/50 select-none">
                {i + 1}
              </span>
              <span className="flex-1">{highlightLine(line, language)}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
