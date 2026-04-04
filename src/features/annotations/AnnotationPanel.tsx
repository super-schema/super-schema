"use client";

import { useState } from "react";
import { MessageSquare, CheckCircle, ChevronDown, ChevronRight } from "lucide-react";
import { AnnotationInput } from "./AnnotationInput";
import { AnnotationItem } from "./AnnotationItem";
import type { Annotation } from "@/types/schemas/compliance";

interface AnnotationPanelProps {
  entityId?: string;
  fieldId?: string;
  annotations: Annotation[];
  onPost: (content: string, taggedUserIds: string[]) => void;
  onResolve: (id: string) => void;
  currentUserId: string;
  loading?: boolean;
}

export function AnnotationPanel({
  entityId,
  fieldId,
  annotations,
  onPost,
  onResolve,
  currentUserId,
  loading,
}: AnnotationPanelProps) {
  const [showResolved, setShowResolved] = useState(false);

  const unresolved = annotations.filter((a) => !a.resolved);
  const resolved = annotations.filter((a) => a.resolved);

  return (
    <div className="flex flex-col h-full" data-testid="annotation-panel">
      {/* Header */}
      <div className="flex items-center gap-space-2 px-space-4 py-space-3 border-b border-border">
        <MessageSquare className="w-4 h-4 text-primary" />
        <h3 className="text-body font-medium">Annotations</h3>
        <span className="text-caption text-muted-foreground ml-auto">
          {annotations.length} comment{annotations.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Annotation list */}
      <div className="flex-1 overflow-y-auto p-space-4 flex flex-col gap-space-3">
        {loading && (
          <div className="flex items-center justify-center py-space-8 text-muted-foreground text-body-small">
            Loading annotations...
          </div>
        )}

        {!loading && annotations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-space-8 gap-space-2 text-center">
            <MessageSquare className="w-8 h-8 text-muted-foreground/50" />
            <p className="text-body-small text-muted-foreground">
              No annotations yet — start a conversation
            </p>
          </div>
        )}

        {/* Unresolved */}
        {unresolved.map((annotation) => (
          <AnnotationItem
            key={annotation.id}
            annotation={annotation}
            onResolve={onResolve}
            canResolve={
              annotation.authorId === currentUserId ||
              true /* Admin check simplified */
            }
          />
        ))}

        {/* Resolved */}
        {resolved.length > 0 && (
          <div>
            <button
              onClick={() => setShowResolved(!showResolved)}
              className="flex items-center gap-space-1 text-caption text-muted-foreground hover:text-foreground transition-colors mb-space-2"
            >
              {showResolved ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              {resolved.length} resolved
            </button>
            {showResolved &&
              resolved.map((annotation) => (
                <AnnotationItem
                  key={annotation.id}
                  annotation={annotation}
                  onResolve={onResolve}
                  canResolve={false}
                />
              ))}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border p-space-4">
        <AnnotationInput onPost={onPost} />
      </div>
    </div>
  );
}
