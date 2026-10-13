"use client";

import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { highlightLine } from "@/lib/syntax-highlight";

interface SchemaCodePreviewProps {
  code: string;
  language?: string;
  onCopy: () => void;
}

export function SchemaCodePreview({ code, language = "sql", onCopy }: SchemaCodePreviewProps) {
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    onCopy();
    setTimeout(() => setCopied(false), 2000);
  }, [code, onCopy]);

  return (
    <div className="relative rounded-md border border-border/50 bg-muted/20 overflow-hidden">
      <div className="flex items-center justify-between px-space-3 py-space-1 bg-muted/30 border-b border-border/50">
        <span className="text-caption text-muted-foreground">Preview</span>
        <button
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
