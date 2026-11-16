"use client";

import { Button } from "@/components/ui/button";
import { useState, useCallback, useRef, useEffect } from "react";
import { Copy, Check, Loader2, RefreshCw, Pencil, Eye, ClipboardPaste, Play, X, AlertTriangle } from "lucide-react";
import { useTypeSpecGeneration } from "./useTypeSpecGeneration";
import { useTransientFlag } from "@/hooks/useTransientFlag";
import {
  parseTypeSpec,
  computeFieldDiff,
  type ParsedTypeSpecField,
  type ExistingFieldSummary,
} from "@/lib/compiler/typespec-parser";
import { applyTypeSpecAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

interface TypeSpecPreviewProps {
  entityId: string;
  /** Increment to trigger regeneration after field edits */
  trigger?: number;
  /** Existing fields for diff computation */
  existingFields?: ExistingFieldSummary[];
  /** Callback after TypeSpec is applied successfully */
  onApplied?: () => void;
}

/**
 * CSS-based TypeSpec syntax highlighting.
 * Highlights keywords, decorators, strings, types, and comments.
 */
function highlightTypeSpec(source: string): React.ReactNode[] {
  const lines = source.split("\n");
  return lines.map((line, i) => (
    <div key={i} className="flex">
      <span className="syntax-comment inline-block w-8 text-right pr-3 select-none text-[12px]">
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
      tokens.push(<span key={key++} className="syntax-comment italic">{commentMatch[1]}</span>);
      remaining = remaining.slice(commentMatch[1].length);
      continue;
    }

    // Decorators: @word or #deprecated
    const decoratorMatch = remaining.match(/^(@\w+|#deprecated)/);
    if (decoratorMatch) {
      tokens.push(<span key={key++} className="syntax-decorator">{decoratorMatch[0]}</span>);
      remaining = remaining.slice(decoratorMatch[0].length);
      continue;
    }

    // Strings
    const stringMatch = remaining.match(/^"([^"\\]|\\.)*"/);
    if (stringMatch) {
      tokens.push(<span key={key++} className="syntax-string">{stringMatch[0]}</span>);
      remaining = remaining.slice(stringMatch[0].length);
      continue;
    }

    // Literal constants share the JSON/YAML palette.
    const constantMatch = remaining.match(/^(true|false|null)\b/);
    if (constantMatch) {
      tokens.push(<span key={key++} className="syntax-constant">{constantMatch[0]}</span>);
      remaining = remaining.slice(constantMatch[0].length);
      continue;
    }

    // Keywords
    const keywordMatch = remaining.match(/^(model|namespace|enum|interface|op|union|alias|scalar|using|import|extends|is)\b/);
    if (keywordMatch) {
      tokens.push(<span key={key++} className="syntax-keyword font-medium">{keywordMatch[0]}</span>);
      remaining = remaining.slice(keywordMatch[0].length);
      continue;
    }

    // TypeSpec built-in types
    const typeMatch = remaining.match(/^(string|integer|int8|int16|int32|int64|float|float32|float64|boolean|bytes|decimal|decimal128|plainDate|plainTime|utcDateTime|offsetDateTime|duration|numeric|safeint|uint8|uint16|uint32|uint64|url|unixTimestamp32|Record|Lifecycle|Versions)\b/);
    if (typeMatch) {
      tokens.push(<span key={key++} className="syntax-type">{typeMatch[0]}</span>);
      remaining = remaining.slice(typeMatch[0].length);
      continue;
    }

    // Numbers
    const numMatch = remaining.match(/^-?\d+(\.\d+)?/);
    if (numMatch) {
      tokens.push(<span key={key++} className="syntax-constant">{numMatch[0]}</span>);
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

// ---------------------------------------------------------------------------
// Diff summary types
// ---------------------------------------------------------------------------

interface DiffSummary {
  toAdd: ParsedTypeSpecField[];
  toUpdate: Array<{ name: string; changes: Partial<ParsedTypeSpecField> }>;
  toRemove: string[];
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TypeSpecPreview({
  entityId,
  trigger = 0,
  existingFields = [],
  onApplied,
}: TypeSpecPreviewProps) {
  const { source, isGenerating, error, refresh } = useTypeSpecGeneration({
    entityId,
    trigger,
  });
  const [copied, flashCopied] = useTransientFlag(2000);

  // Edit mode state
  const [isEditMode, setIsEditMode] = useState(false);
  const [editSource, setEditSource] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [diffSummary, setDiffSummary] = useState<DiffSummary | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [showConfirmRemove, setShowConfirmRemove] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleCopy = useCallback(async () => {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
      flashCopied();
    } catch {
      // Ignore clipboard errors
    }
  }, [source, flashCopied]);

  // Enter edit mode, pre-populate with current source
  const enterEditMode = useCallback(() => {
    setEditSource(source || "");
    setParseError(null);
    setDiffSummary(null);
    setApplyError(null);
    setShowConfirmRemove(false);
    setIsEditMode(true);
  }, [source]);

  // Exit edit mode
  const exitEditMode = useCallback(() => {
    setIsEditMode(false);
    setEditSource("");
    setParseError(null);
    setDiffSummary(null);
    setApplyError(null);
    setShowConfirmRemove(false);
  }, []);

  // Parse and compute diff
  const handlePreviewChanges = useCallback(() => {
    setParseError(null);
    setApplyError(null);
    setDiffSummary(null);
    setShowConfirmRemove(false);

    const parsed = parseTypeSpec(editSource);
    if (!parsed) {
      setParseError("Could not parse TypeSpec. Ensure it contains a valid model block.");
      return;
    }

    if (parsed.fields.length === 0 && existingFields.length === 0) {
      setParseError("No fields found in the TypeSpec model.");
      return;
    }

    const diff = computeFieldDiff(parsed.fields, existingFields);
    setDiffSummary(diff);
  }, [editSource, existingFields]);

  // Apply changes. The text goes to the server as written: the server compiles it and writes what it means (the browser parse above only
  // draws the diff, it never decides what is stored).
  const handleApply = useCallback(async (removeFields?: string[]) => {
    setIsApplying(true);
    setApplyError(null);

    try {
      const result = await applyTypeSpecAction(entityId, editSource, removeFields);

      if (result.error) {
        setApplyError(result.error);
      } else {
        // Success — exit edit mode and refresh preview
        exitEditMode();
        refresh();
        onApplied?.();
      }
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : "Failed to apply TypeSpec");
    } finally {
      setIsApplying(false);
    }
  }, [editSource, entityId, exitEditMode, refresh, onApplied]);

  // Handle Cmd+Enter keyboard shortcut
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (diffSummary) {
          if (diffSummary.toRemove.length > 0 && !showConfirmRemove) {
            setShowConfirmRemove(true);
          } else {
            handleApply(showConfirmRemove ? diffSummary.toRemove : undefined);
          }
        } else {
          handlePreviewChanges();
        }
      }
    },
    [diffSummary, showConfirmRemove, handleApply, handlePreviewChanges]
  );

  // Paste button
  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setEditSource(text);
      setDiffSummary(null);
      setParseError(null);
    } catch {
      // Clipboard read failed — focus textarea so user can Cmd+V
      textareaRef.current?.focus();
    }
  }, []);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (isEditMode && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isEditMode]);

  return (
    <div className="flex flex-col h-full" data-testid="typespec-preview">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-space-4 py-space-2 border-b border-border/50">
        <span className="text-caption text-muted-foreground font-medium">
          {isEditMode ? "TypeSpec Editor" : "TypeSpec Preview"}
        </span>
        <div className="flex items-center gap-1">
          {isGenerating && !isEditMode && (
            <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
          )}

          {/* Edit / Preview toggle */}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={isEditMode ? exitEditMode : enterEditMode}
            className="text-muted-foreground"
            title={isEditMode ? "Back to preview" : "Edit TypeSpec"}
            aria-label={isEditMode ? "Back to preview" : "Edit TypeSpec"}
            data-testid="typespec-edit-toggle"
          >
            {isEditMode ? (
              <Eye className="size-3.5" />
            ) : (
              <Pencil className="size-3.5" />
            )}
          </Button>

          {isEditMode && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handlePaste}
              className="text-muted-foreground"
              title="Paste TypeSpec from clipboard"
              aria-label="Paste TypeSpec from clipboard"
              data-testid="typespec-paste-btn"
            >
              <ClipboardPaste className="size-3.5" />
            </Button>
          )}

          {!isEditMode && (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={refresh}
                className="text-muted-foreground"
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleCopy}
                className="text-muted-foreground"
                title="Copy to clipboard"
                aria-label="Copy to clipboard"
                disabled={!source}
              >
                {copied ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Content area */}
      {isEditMode ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Textarea */}
          <div className="schema-code flex-1 overflow-auto">
            <textarea
              ref={textareaRef}
              value={editSource}
              onChange={(e) => {
                setEditSource(e.target.value);
                setDiffSummary(null);
                setParseError(null);
              }}
              onKeyDown={handleKeyDown}
              className="w-full h-full min-h-[200px] p-space-3 bg-transparent font-mono text-[13px] leading-5 resize-none border-none outline-none placeholder:text-[var(--code-comment)]"
              placeholder="Paste or type TypeSpec here..."
              spellCheck={false}
              data-testid="typespec-editor-textarea"
            />
          </div>

          {/* Parse error */}
          {parseError && (
            <div className="px-space-3 py-space-2 text-caption text-destructive border-t border-border/50 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{parseError}</span>
            </div>
          )}

          {/* Apply error */}
          {applyError && (
            <div className="px-space-3 py-space-2 text-caption text-destructive border-t border-border/50 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{applyError}</span>
            </div>
          )}

          {/* Diff summary */}
          {diffSummary && (
            <div className="px-space-3 py-space-2 border-t border-border/50 text-caption" data-testid="typespec-diff-summary">
              <div className="space-y-1">
                {diffSummary.toAdd.length > 0 && (
                  <div className="text-green-400">
                    + Add {diffSummary.toAdd.length} field{diffSummary.toAdd.length !== 1 ? "s" : ""}:{" "}
                    <span className="text-muted-foreground">
                      {diffSummary.toAdd.map((f) => f.name).join(", ")}
                    </span>
                  </div>
                )}
                {diffSummary.toUpdate.length > 0 && (
                  <div className="text-amber-400">
                    ~ Update {diffSummary.toUpdate.length} field{diffSummary.toUpdate.length !== 1 ? "s" : ""}:{" "}
                    <span className="text-muted-foreground">
                      {diffSummary.toUpdate.map((f) => f.name).join(", ")}
                    </span>
                  </div>
                )}
                {diffSummary.toRemove.length > 0 && (
                  <div className="text-red-400">
                    - Remove {diffSummary.toRemove.length} field{diffSummary.toRemove.length !== 1 ? "s" : ""}:{" "}
                    <span className="text-muted-foreground">
                      {diffSummary.toRemove.map((f) => f).join(", ")}
                    </span>
                  </div>
                )}
                {diffSummary.toAdd.length === 0 && diffSummary.toUpdate.length === 0 && diffSummary.toRemove.length === 0 && (
                  <div className="text-muted-foreground">No changes detected.</div>
                )}
              </div>

              {/* Confirm removal dialog */}
              {showConfirmRemove && diffSummary.toRemove.length > 0 && (
                <div className="mt-2 p-2 rounded bg-destructive/10 border border-destructive/30 text-caption">
                  <p className="text-destructive font-medium mb-1">
                    Confirm field removal
                  </p>
                  <p className="text-muted-foreground mb-2">
                    The following fields will be permanently deleted:{" "}
                    <strong>{diffSummary.toRemove.join(", ")}</strong>
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => handleApply(diffSummary.toRemove)}
                      disabled={isApplying}
                      data-testid="typespec-confirm-remove-btn"
                    >
                      {isApplying ? "Applying..." : "Remove & Apply"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={() => handleApply()}
                      disabled={isApplying}
                    >
                      {isApplying ? "Applying..." : "Apply Without Removing"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setShowConfirmRemove(false)}
                      className="text-muted-foreground"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 px-space-3 py-space-2 border-t border-border/50">
            {!diffSummary ? (
              <Button
                size="sm"
                onClick={handlePreviewChanges}
                disabled={!editSource.trim()}
                data-testid="typespec-preview-changes-btn"
              >
                <Eye />
                Preview Changes
              </Button>
            ) : (
              <>
                {(!diffSummary.toRemove.length || showConfirmRemove) ? null : (
                  <Button
                    size="sm"
                    onClick={() => {
                      if (diffSummary.toRemove.length > 0) {
                        setShowConfirmRemove(true);
                      } else {
                        handleApply();
                      }
                    }}
                    disabled={isApplying || (diffSummary.toAdd.length === 0 && diffSummary.toUpdate.length === 0 && diffSummary.toRemove.length === 0)}
                    data-testid="typespec-apply-btn"
                  >
                    <Play />
                    {isApplying ? "Applying..." : "Apply Changes"}
                  </Button>
                )}
                {diffSummary.toRemove.length === 0 && (
                  <Button
                    size="sm"
                    onClick={() => handleApply()}
                    disabled={isApplying || (diffSummary.toAdd.length === 0 && diffSummary.toUpdate.length === 0)}
                    data-testid="typespec-apply-btn"
                  >
                    <Play />
                    {isApplying ? "Applying..." : "Apply Changes"}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDiffSummary(null);
                    setShowConfirmRemove(false);
                  }}
                >
                  <X />
                  Back to Editor
                </Button>
              </>
            )}
            <span className="text-caption text-muted-foreground/50 ml-auto">
              {isEditMode && "Cmd+Enter to apply"}
            </span>
          </div>
        </div>
      ) : (
        /* View mode (original) */
        <div className="schema-code flex-1 overflow-auto p-space-3" tabIndex={0} role="region" aria-label="TypeSpec preview">
          {error ? (
            <div className="text-caption text-destructive p-space-2">
              {error}
            </div>
          ) : source ? (
            <pre className="font-mono text-[13px] leading-5 whitespace-pre">
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
      )}
    </div>
  );
}
