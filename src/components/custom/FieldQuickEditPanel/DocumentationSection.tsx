"use client";

import { Input } from "@/components/ui/input";

interface DocumentationSectionProps {
  description: string;
  summary: string;
  isReadOnly?: boolean;
  onChange: (field: string, value: string) => void;
}

export function DocumentationSection({
  description,
  summary,
  isReadOnly = false,
  onChange,
}: DocumentationSectionProps) {
  return (
    <div className="space-y-space-3">
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Description</label>
        <textarea
          value={description}
          onChange={(e) => onChange("description", e.target.value)}
          placeholder="Describe this field..."
          rows={3}
          disabled={isReadOnly}
          className="w-full rounded-lg border border-border bg-popover px-3 py-2 text-body-small text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring resize-none disabled:opacity-50"
        />
      </div>
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Summary</label>
        <Input
          value={summary}
          onChange={(e) => onChange("summary", e.target.value)}
          placeholder="Brief one-line summary"
          className="h-8 text-body-small"
          disabled={isReadOnly}
        />
      </div>
    </div>
  );
}
