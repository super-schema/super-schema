"use client";

import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const CLASSIFICATIONS = [
  { value: "NEVER_STORED", label: "Class 1 — Never Stored", shortLabel: "Never Stored", badgeClass: "badge-never-stored" },
  { value: "PII", label: "Class 2 — PII", shortLabel: "PII", badgeClass: "badge-pii" },
  { value: "SENSITIVE", label: "Class 3 — Sensitive", shortLabel: "Sensitive", badgeClass: "badge-sensitive" },
  { value: "INTERNAL", label: "Class 4 — Internal", shortLabel: "Internal", badgeClass: "badge-internal" },
  { value: "PUBLIC", label: "Class 5 — Public", shortLabel: "Public", badgeClass: "badge-public" },
] as const;

/** Resolve null/undefined to SENSITIVE (Class 3 default) */
function resolveClassification(value: string | null | undefined) {
  return CLASSIFICATIONS.find((c) => c.value === value) ?? CLASSIFICATIONS[2]; // SENSITIVE
}

interface ClassificationPickerProps {
  value: string | null;
  onChange: (value: string | null) => void;
}

export function ClassificationPicker({ value, onChange }: ClassificationPickerProps) {
  const [open, setOpen] = useState(false);

  const current = resolveClassification(value);
  const isDefault = value == null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex items-center gap-1 outline-none cursor-pointer">
        <span className={`${current.badgeClass} text-caption px-1.5 py-0.5 rounded`}>
          {isDefault ? "Class 3" : current.shortLabel}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-1">
        <div className="flex flex-col gap-0.5">
          {CLASSIFICATIONS.map((cls) => (
            <button
              key={cls.value}
              onClick={() => {
                onChange(cls.value);
                setOpen(false);
              }}
              className={`flex items-center gap-2 px-2 py-1.5 rounded text-caption hover:bg-accent/50 transition-colors text-left w-full ${
                current.value === cls.value ? "bg-accent/30" : ""
              }`}
            >
              <span className={`${cls.badgeClass} px-1.5 py-0.5 rounded text-[11px]`}>
                {cls.shortLabel}
              </span>
              <span className="text-muted-foreground/70 text-[10px]">
                {cls.label.split(" — ")[0]}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
