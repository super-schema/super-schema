"use client";

// src/features/events/builder/template/InfoTip.tsx
// A compact info button for the help text of an OPTIONAL field (the text of a required field stays inline). The button has an aria-label and
// `aria-describedby` pointing at the tip, which is always in the DOM (hidden until hover / focus / click), so a screen reader reads it as the
// button's description. Escape closes it; hovering the tip keeps it open (WCAG 1.4.13: dismissible, hoverable, persistent).
import { useState, type ReactNode } from "react";
import { Info } from "lucide-react";

export function InfoTip({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button" aria-label={label} aria-describedby={id} data-testid={`${id}-button`}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
        className="rounded-full p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Info aria-hidden="true" className="size-3.5" />
      </button>
      <span
        id={id} role="tooltip" data-testid={id} hidden={!open}
        className="absolute left-0 top-full z-20 mt-1 w-64 max-w-[80vw] rounded-md bg-foreground px-space-3 py-space-2 text-caption font-normal text-background shadow-md"
      >
        {children}
      </span>
    </span>
  );
}
