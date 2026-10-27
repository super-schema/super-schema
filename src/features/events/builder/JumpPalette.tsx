"use client";

// src/features/events/builder/JumpPalette.tsx
// "Jump to…": a searchable list of every section, message, channel, operation and server of the event, so a long event is not a hunt
// through tabs. Opened from the outline's button or with Mod+J (EventBuilder owns both). Choosing an entry reports it and closes.
import { useState } from "react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { JumpEntry } from "./jump";

const problemsText = (n: number) => (n === 1 ? "1 problem" : `${n} problems`);

export function JumpPalette({ open, onOpenChange, entries, onJump }: {
  open: boolean; onOpenChange: (open: boolean) => void; entries: JumpEntry[]; onJump: (entry: JumpEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = entries.filter((e) => needle === "" || e.label.toLowerCase().includes(needle));
  // Groups in the order their first entry appears (the sections, then each section's items).
  const groups = [...new Set(shown.map((e) => e.group))].map((group) => ({ group, entries: shown.filter((e) => e.group === group) }));

  function change(next: boolean) {
    if (!next) setQuery("");
    onOpenChange(next);
  }

  return (
    <CommandDialog open={open} onOpenChange={change} title="Jump to" description="Search the sections and items of this event">
      <Command shouldFilter={false}>
        <CommandInput value={query} onValueChange={setQuery} placeholder="Jump to a section, message, channel, operation…" />
        <CommandList>
          {shown.length === 0 && <CommandEmpty>Nothing matches</CommandEmpty>}
          {groups.map(({ group, entries: inGroup }) => (
            <CommandGroup key={group} heading={group}>
              {inGroup.map((entry) => (
                <CommandItem
                  key={`${entry.section}|${entry.item ?? ""}|${entry.group}|${entry.label}`} value={`${entry.group}|${entry.label}|${entry.item ?? ""}`}
                  aria-label={entry.problems > 0 ? `${entry.label}, ${problemsText(entry.problems)}` : undefined}
                  onSelect={() => { onJump(entry); change(false); }}
                >
                  {entry.label}
                  {entry.problems > 0 && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
