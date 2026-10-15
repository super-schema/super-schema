"use client";

import { useMemo } from "react";
import { Textarea } from "@/components/ui/textarea";
import { parseJsonObjectArrayText, parseJsonObjectText } from "@/lib/events/inputs";

/** Raw JSON editor for bindings / parameters / examples (binding forms are Phase 5). */
export function JsonField({
  id, label, value, onChange, mode, rows = 4, placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  mode: "object" | "array";
  rows?: number;
  placeholder?: string;
}) {
  const problem = useMemo(() => {
    const r = mode === "object" ? parseJsonObjectText(value, label) : parseJsonObjectArrayText(value, label);
    return r.success ? null : r.error.message;
  }, [value, mode, label]);
  return (
    <div className="space-y-space-1">
      <label htmlFor={id} className="block text-caption text-muted-foreground">{label}</label>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder ?? (mode === "object" ? "{ }" : "[ ]")}
        aria-invalid={problem ? "true" : "false"}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-caption"
      />
      {problem && <p role="alert" className="text-caption text-destructive">{problem}</p>}
    </div>
  );
}
