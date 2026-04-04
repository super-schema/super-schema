"use client";

import { CheckCircle } from "lucide-react";
import type { Annotation } from "@/types/schemas/compliance";

interface AnnotationItemProps {
  annotation: Annotation;
  onResolve: (id: string) => void;
  canResolve: boolean;
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AnnotationItem({
  annotation,
  onResolve,
  canResolve,
}: AnnotationItemProps) {
  return (
    <div
      className={`rounded-lg p-space-3 surface-1 border border-border ${annotation.resolved ? "opacity-50" : ""}`}
      data-testid="annotation-item"
    >
      {/* Header */}
      <div className="flex items-center gap-space-2 mb-space-1">
        {/* Avatar */}
        <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-caption text-primary font-medium shrink-0">
          {(annotation.authorName || "U").charAt(0).toUpperCase()}
        </div>
        <span className="text-body-small font-medium text-foreground">
          {annotation.authorName || "Unknown"}
        </span>
        <span className="text-caption text-muted-foreground">
          {relativeTime(annotation.createdAt)}
        </span>
        {annotation.resolved && (
          <span className="inline-block px-1.5 py-0.5 rounded text-caption font-medium bg-green-500/20 text-green-400 ml-auto">
            Resolved
          </span>
        )}
      </div>

      {/* Content */}
      <p className="text-body-small text-foreground whitespace-pre-wrap ml-8">
        {annotation.content}
      </p>

      {/* Tagged users */}
      {annotation.taggedUserIds.length > 0 && (
        <div className="flex gap-space-1 ml-8 mt-space-1">
          {annotation.taggedUserIds.map((uid) => (
            <span
              key={uid}
              className="inline-block px-1.5 py-0.5 rounded text-caption bg-primary/10 text-primary"
            >
              @{uid}
            </span>
          ))}
        </div>
      )}

      {/* Resolve button */}
      {canResolve && !annotation.resolved && (
        <div className="flex justify-end mt-space-2">
          <button
            onClick={() => onResolve(annotation.id)}
            className="flex items-center gap-1 text-caption text-muted-foreground hover:text-green-400 transition-colors"
          >
            <CheckCircle className="w-3 h-3" />
            Resolve
          </button>
        </div>
      )}
    </div>
  );
}
