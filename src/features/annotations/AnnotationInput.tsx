"use client";

import { useState, useRef, useCallback } from "react";
import { Send } from "lucide-react";

interface AnnotationInputProps {
  onPost: (content: string, taggedUserIds: string[]) => void;
  disabled?: boolean;
}

export function AnnotationInput({ onPost, disabled }: AnnotationInputProps) {
  const [content, setContent] = useState("");
  const [taggedUserIds, setTaggedUserIds] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    if (!content.trim()) return;
    onPost(content.trim(), taggedUserIds);
    setContent("");
    setTaggedUserIds([]);
  }, [content, taggedUserIds, onPost]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div data-testid="annotation-input">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment..."
        rows={3}
        disabled={disabled}
        className="w-full bg-muted text-foreground text-body-small rounded-lg px-space-3 py-space-2 border border-border outline-none resize-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
      />
      <div className="flex items-center justify-between mt-space-2">
        <span className="text-caption text-muted-foreground">
          {content.length > 0 ? `${content.length} chars` : "Cmd+Enter to post"}
        </span>
        <button
          onClick={handleSubmit}
          disabled={!content.trim() || disabled}
          className="flex items-center gap-space-1 px-space-3 py-1 text-body-small bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send className="w-3 h-3" />
          Post
        </button>
      </div>
    </div>
  );
}
