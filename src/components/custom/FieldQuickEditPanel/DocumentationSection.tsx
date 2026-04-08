"use client";

import { Input } from "@/components/ui/input";

interface DocumentationSectionProps {
  summary: string;
  isReadOnly?: boolean;
  onChange: (field: string, value: string) => void;
}

export function DocumentationSection({
  summary,
  isReadOnly = false,
  onChange,
}: DocumentationSectionProps) {
  return (
    <div className="space-y-space-3">
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
