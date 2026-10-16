"use client";

// src/features/events/builder/sections/PropertiesChooser.tsx
// The single "+ Add" of message properties. One primary button opens a popover:
//   Applies to  [ Message | Operation ]     (segmented; locked and hidden when the chooser is opened from a message or an operation)
//   a search box, then the groups
//     Built in     the bundled library sets of that kind ("CloudEvents 1.0 — 8 properties")
//     Library      the other Tenant / Domain library sets of that kind
//     New (blank)  an empty local set
// Choosing an item calls `onChoose` right away (the caller adds it to the document and selects / applies it): no key field, no form.
// Test ids: the trigger is `triggerTestId`; inside, `trait-chooser`, `trait-chooser-kind(-message|-operation)`, `trait-chooser-search`,
// `trait-chooser-group-builtin|library|new`, `trait-chooser-item-<library id>` and `trait-chooser-item-new`, `trait-chooser-empty`.
import { useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { TraitKind } from "@/lib/event-specs/types";
import type { LibraryTraitOption } from "../EventBuilder";
import { addPropertiesLabel, BUILT_IN_BADGE, chooserItemText, LIBRARY_BADGE, newPropertiesLabel, propertiesName, TRAIT_BADGE } from "../labels";
import { optionPropertyCount, type TraitChoice } from "../traits";

const KINDS: Array<{ kind: TraitKind; label: string }> = [
  { kind: "MESSAGE", label: "Message" },
  { kind: "OPERATION", label: "Operation" },
];

export interface PropertiesChooserProps {
  library: LibraryTraitOption[];
  /** Lock the chooser to one kind (opened from a message or an operation card): the segmented control is not shown. */
  kind?: TraitKind;
  /** The kind it starts on when it is not locked. */
  defaultKind?: TraitKind;
  /** Library trait ids that cannot be chosen again here (already applied to this message): shown as "Added". */
  disabledIds?: ReadonlyArray<string>;
  /** Library trait ids the event already has an entry for: shown as "In this event" (choosing one reuses the entry). */
  usedIds?: ReadonlyArray<string>;
  onChoose: (choice: TraitChoice) => void;
  triggerTestId: string;
  /** Accessible name of the trigger; defaults to "Add message properties" / "Add operation properties". */
  triggerLabel?: string;
  /** The trigger's look: the section's primary button, or the quiet one inside a card. */
  triggerVariant?: "default" | "outline";
}

/** The count a chooser item shows: only when the library trait brings properties. */
function countOf(option: LibraryTraitOption): number | null {
  const n = option.kind === "MESSAGE" ? optionPropertyCount(option) : null;
  return n !== null && n > 0 ? n : null;
}

/** An option matches a search text when its name, level or summary contains every word (case-insensitive). */
function matches(option: LibraryTraitOption, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${option.name} ${option.level ?? ""} ${option.bundled ? BUILT_IN_BADGE : LIBRARY_BADGE}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function PropertiesChooser({
  library, kind: lockedKind, defaultKind = "MESSAGE", disabledIds = [], usedIds = [], onChoose, triggerTestId, triggerLabel, triggerVariant = "default",
}: PropertiesChooserProps) {
  const [open, setOpen] = useState(false);
  const [pickedKind, setPickedKind] = useState<TraitKind>(defaultKind);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // A blank set puts the focus in its own name field: the popover must not pull it back to the trigger when it closes.
  const focusMoves = useRef(false);
  const kind = lockedKind ?? pickedKind;

  const ofKind = useMemo(() => library.filter((l) => l.kind === kind && matches(l, query)), [library, kind, query]);
  const builtIn = ofKind.filter((l) => l.bundled === true);
  const others = ofKind.filter((l) => l.bundled !== true);
  const blank = newPropertiesLabel(kind);
  const showBlank = query.trim() === "" || blank.toLowerCase().includes(query.trim().toLowerCase()) || "new blank".includes(query.trim().toLowerCase());
  const nothing = builtIn.length === 0 && others.length === 0 && !showBlank;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      // Every opening starts clean: the default kind, an empty search.
      setQuery("");
      setPickedKind(defaultKind);
      focusMoves.current = false;
    }
  }

  function choose(choice: TraitChoice) {
    focusMoves.current = choice.type === "blank";
    setOpen(false);
    onChoose(choice);
  }

  const item = (option: LibraryTraitOption) => {
    const disabled = disabledIds.includes(option.id);
    const inEvent = usedIds.includes(option.id);
    const count = countOf(option);
    return (
      <CommandItem
        key={option.id} value={option.id} disabled={disabled} data-testid={`trait-chooser-item-${option.id}`}
        onSelect={() => choose({ type: "library", option })}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-small text-foreground">{chooserItemText(option.name, count)}</span>
          {option.level && <span className="block truncate text-caption text-muted-foreground">{option.level}</span>}
        </span>
        {disabled ? (
          <span data-testid={`trait-chooser-item-${option.id}-state`} className="text-caption text-muted-foreground">Added</span>
        ) : inEvent ? (
          <span data-testid={`trait-chooser-item-${option.id}-state`} className="text-caption text-muted-foreground">In this event</span>
        ) : null}
      </CommandItem>
    );
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        type="button" data-testid={triggerTestId} aria-label={triggerLabel ?? addPropertiesLabel(kind)}
        className={buttonVariants({ size: "sm", variant: triggerVariant, className: "gap-1.5" })}
      >
        <Plus aria-hidden="true" className="size-4" /> Add
      </PopoverTrigger>
      <PopoverContent
        align="end" initialFocus={searchRef} finalFocus={() => !focusMoves.current}
        className="w-[26rem] max-w-[calc(100vw-2rem)] gap-0 p-0" data-testid="trait-chooser"
      >
        <Command shouldFilter={false} aria-label={`Add ${propertiesName(kind).toLowerCase()}`}>
          <div className="space-y-space-2 p-space-2 pb-0">
            {lockedKind ? (
              <p data-testid="trait-chooser-kind-locked" className="text-caption text-muted-foreground">
                Applies to: <span className="font-medium text-foreground">{lockedKind === "MESSAGE" ? "this message" : "this operation"}</span>
              </p>
            ) : (
              <div className="flex items-center gap-space-2">
                <span id="trait-chooser-kind-label" className="text-caption text-muted-foreground">Applies to</span>
                <div role="radiogroup" aria-labelledby="trait-chooser-kind-label" data-testid="trait-chooser-kind" className="inline-flex rounded-lg bg-muted p-[3px]">
                  {KINDS.map((k) => (
                    <button
                      key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} data-testid={`trait-chooser-kind-${k.kind.toLowerCase()}`}
                      onClick={() => setPickedKind(k.kind)}
                      className={cn(
                        "rounded-md px-space-3 py-0.5 text-body-small outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                        kind === k.kind ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <CommandInput
            ref={searchRef} value={query} onValueChange={setQuery} data-testid="trait-chooser-search"
            placeholder={`Search ${propertiesName(kind).toLowerCase()}…`} aria-label={`Search ${propertiesName(kind).toLowerCase()}`}
          />
          <CommandList>
            {nothing && <CommandEmpty data-testid="trait-chooser-empty">Nothing matches &ldquo;{query}&rdquo;.</CommandEmpty>}
            {builtIn.length > 0 && <CommandGroup heading={BUILT_IN_BADGE} data-testid="trait-chooser-group-builtin">{builtIn.map(item)}</CommandGroup>}
            {others.length > 0 && <CommandGroup heading={LIBRARY_BADGE} data-testid="trait-chooser-group-library">{others.map(item)}</CommandGroup>}
            {showBlank && (
              <CommandGroup heading="New (blank)" data-testid="trait-chooser-group-new">
                <CommandItem value="new" data-testid="trait-chooser-item-new" onSelect={() => choose({ type: "blank", kind })}>
                  <Plus aria-hidden="true" className="size-4" />
                  <span className="min-w-0 flex-1 text-body-small text-foreground">{blank}</span>
                  <span className="text-caption text-muted-foreground">{TRAIT_BADGE}</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
