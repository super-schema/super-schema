"use client";

import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const CLASSIFICATIONS = [
  { value: null, label: "None", badgeClass: "" },
  { value: "PII", label: "PII", badgeClass: "badge-pii" },
  { value: "SENSITIVE", label: "Sensitive", badgeClass: "badge-sensitive" },
  { value: "INTERNAL", label: "Internal", badgeClass: "badge-internal" },
  { value: "PUBLIC", label: "Public", badgeClass: "badge-public" },
] as const;

interface ClassificationPickerProps {
  value: string | null;
  onChange: (value: string | null) => void;
}

export function ClassificationPicker({ value, onChange }: ClassificationPickerProps) {
  const [open, setOpen] = useState(false);

  const current = CLASSIFICATIONS.find((c) => c.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex items-center outline-none cursor-pointer">
        {current && current.value ? (
          <span className={`${current.badgeClass} text-caption px-1.5 py-0.5 rounded`}>
            {current.label}
          </span>
        ) : (
          <span className="text-caption text-muted-foreground/50 hover:text-muted-foreground transition-colors">
            —
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-40 p-1">
        <div className="flex flex-col gap-0.5">
          {CLASSIFICATIONS.map((cls) => (
            <button
              key={cls.label}
              onClick={() => {
                onChange(cls.value);
                setOpen(false);
              }}
              className={`flex items-center gap-2 px-2 py-1.5 rounded text-caption hover:bg-accent/50 transition-colors text-left w-full ${
                value === cls.value ? "bg-accent/30" : ""
              }`}
            >
              {cls.value ? (
                <span className={`${cls.badgeClass} px-1.5 py-0.5 rounded text-[11px]`}>
                  {cls.label}
                </span>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
