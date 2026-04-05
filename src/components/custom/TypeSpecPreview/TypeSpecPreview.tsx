"use client";

import { useState, useCallback } from "react";
import { Copy, Check, Loader2, RefreshCw } from "lucide-react";
import { useTypeSpecGeneration } from "./useTypeSpecGeneration";

interface TypeSpecPreviewProps {
  entityId: string;
  /** Increment to trigger regeneration after field edits */
  trigger?: number;
}

/**
 * CSS-based TypeSpec syntax highlighting.
 * Highlights keywords, decorators, strings, types, and comments.
 */
function highlightTypeSpec(source: string): React.ReactNode[] {
  const lines = source.split("\n");
  return lines.map((line, i) => (
    <div key={i} className="flex">
      <span className="inline-block w-8 text-right pr-3 select-none text-muted-foreground/40 text-[12px]">
        {i + 1}
      </span>
      <span className="flex-1">
        <HighlightedLine line={line} />
      </span>
    </div>
  ));
}

function HighlightedLine({ line }: { line: string }) {
  // Simple tokenizer for TypeSpec
  const tokens: React.ReactNode[] = [];
  let remaining = line;
  let key = 0;

  while (remaining.length > 0) {
    // Comments
    const commentMatch = remaining.match(/^(\/\/.*)/);
    if (commentMatch) {
      tokens.push(<span key={key++} className="text-muted-foreground/60 italic">{commentMatch[1]}</span>);
      remaining = remaining.slice(commentMatch[1].length);
      continue;
    }

    // Decorators: @word or #deprecated
    const decoratorMatch = remaining.match(/^(@\w+|#deprecated)/);
    if (decoratorMatch) {
      tokens.push(<span key={key++} className="text-purple-400">{decoratorMatch[0]}</span>);
      remaining = remaining.slice(decoratorMatch[0].length);
      continue;
    }

    // Strings
    const stringMatch = remaining.match(/^"([^"\\]|\\.)*"/);
    if (stringMatch) {
      tokens.push(<span key={key++} className="text-green-400">{stringMatch[0]}</span>);
      remaining = remaining.slice(stringMatch[0].length);
      continue;
    }

    // Keywords
    const keywordMatch = remaining.match(/^(model|namespace|enum|interface|op|union|alias|scalar|using|import|extends|is)\b/);
    if (keywordMatch) {
      tokens.push(<span key={key++} className="text-blue-400 font-medium">{keywordMatch[0]}</span>);
      remaining = remaining.slice(keywordMatch[0].length);
      continue;
    }

    // TypeSpec built-in types
    const typeMatch = remaining.match(/^(string|integer|int8|int16|int32|int64|float|float32|float64|boolean|bytes|decimal|decimal128|plainDate|plainTime|utcDateTime|offsetDateTime|duration|numeric|safeint|uint8|uint16|uint32|uint64|url|unixTimestamp32|Record|Lifecycle|Versions)\b/);
    if (typeMatch) {
      tokens.push(<span key={key++} className="text-cyan-400">{typeMatch[0]}</span>);
      remaining = remaining.slice(typeMatch[0].length);
      continue;
    }

    // Numbers
    const numMatch = remaining.match(/^-?\d+(\.\d+)?/);
    if (numMatch) {
      tokens.push(<span key={key++} className="text-amber-400">{numMatch[0]}</span>);
      remaining = remaining.slice(numMatch[0].length);
      continue;
    }

    // Punctuation and identifiers
    const plainMatch = remaining.match(/^[^@"#\w]+|^\w+/);
    if (plainMatch) {
      tokens.push(<span key={key++}>{plainMatch[0]}</span>);
      remaining = remaining.slice(plainMatch[0].length);
      continue;
    }

    // Fallback: single character
    tokens.push(<span key={key++}>{remaining[0]}</span>);
    remaining = remaining.slice(1);
  }

  return <>{tokens}</>;
}

export function TypeSpecPreview({ entityId, trigger = 0 }: TypeSpecPreviewProps) {
  const { source, isGenerating, error, refresh } = useTypeSpecGeneration({
    entityId,
    trigger,
  });
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard errors
    }
  }, [source]);

  return (
    <div className="flex flex-col h-full" data-testid="typespec-preview">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-space-4 py-space-2 border-b border-border/50">
        <span className="text-caption text-muted-foreground font-medium">TypeSpec Preview</span>
        <div className="flex items-center gap-1">
          {isGenerating && (
            <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
          )}
          <button
            onClick={refresh}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Copy to clipboard"
            disabled={!source}
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Code area */}
      <div className="flex-1 overflow-auto p-space-3">
        {error ? (
          <div className="text-caption text-destructive p-space-2">
            {error}
          </div>
        ) : source ? (
          <pre className="font-mono text-[12px] text-foreground leading-5 whitespace-pre">
            {highlightTypeSpec(source)}
          </pre>
        ) : isGenerating ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
          </div>
        ) : (
          <p className="text-caption text-muted-foreground/60 italic p-space-2">
            No fields defined yet.
          </p>
        )}
      </div>
    </div>
  );
}
