"use client";

import type { LucideIcon } from "lucide-react";

interface TypeGridItemProps {
  icon: LucideIcon;
  iconColor: string;
  label: string;
  description: string;
  example?: string;
  isSelected: boolean;
  onClick: () => void;
}

export function TypeGridItem({
  icon: Icon,
  iconColor,
  label,
  description,
  example,
  isSelected,
  onClick,
}: TypeGridItemProps) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-all text-center cursor-pointer group ${
        isSelected
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border/50 hover:border-primary/40 hover:bg-accent/30 text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className={`w-5 h-5 ${isSelected ? "text-primary" : iconColor}`} />
      <span className="text-[11px] font-medium leading-tight truncate w-full">
        {label}
      </span>
      <span className="text-[9px] text-muted-foreground/60 leading-tight line-clamp-2">
        {description}
      </span>
      {example && (
        <span className="text-[8px] text-muted-foreground/40 leading-tight truncate w-full font-mono">
          {example}
        </span>
      )}
    </button>
  );
}
