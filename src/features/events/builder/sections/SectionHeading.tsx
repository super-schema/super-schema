"use client";

// src/features/events/builder/sections/SectionHeading.tsx
// The heading of a list section (Messages, Channels, Operations, Servers): one line, with the sentence that used to sit under it
// in an info tip, so the working area starts higher. `section` is the section's name in the ids: `${section}-heading` is the
// h2 (the section's `aria-labelledby`), `${section}-help` the tip and `${section}-help-button` its button ("About messages").
import type { ReactNode } from "react";
import { InfoTip } from "../template/InfoTip";

export function SectionHeading({ section, title, children }: { section: string; title: string; children: ReactNode }) {
  return (
    <header className="flex items-center gap-space-2">
      <h2 id={`${section}-heading`} className="text-heading-3 text-foreground">{title}</h2>
      <InfoTip id={`${section}-help`} label={`About ${section}`}>{children}</InfoTip>
    </header>
  );
}
