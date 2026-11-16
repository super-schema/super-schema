"use client";

import { useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { useTransientFlag } from "@/hooks/useTransientFlag";
import { highlightLine } from "@/lib/syntax-highlight";
import { Button } from "@/components/ui/button";

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
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="schema-code-copy"
          onClick={handleCopy}
          className="text-muted-foreground"
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
        </Button>
      </div>
      <pre className="schema-code p-space-3 text-[13px] leading-5 font-mono overflow-x-auto max-h-80 overflow-y-auto">
        <code>
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span className="syntax-comment inline-block w-8 text-right pr-3 select-none">
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
