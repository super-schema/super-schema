"use client";

// src/features/events/builder/sections/FormCard.tsx
// The accordion cards of the message and operation forms. A card is a bordered section whose heading is a button (aria-expanded,
// aria-controls): the title, a small badge with the number of fields set, and a chevron. `useCardState` keeps which cards the user opened
// or closed at the SECTION, so the choice survives switching from one item to another; a card with no choice of its own follows its
// default (which can depend on the item: Reply is open when the operation has one). A card that newly holds a problem opens by itself.
import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface CardState {
  isOpen: (id: string) => boolean;
  setOpen: (id: string, open: boolean) => void;
}

/**
 * `defaults`: card id -> open by default (for the item being shown). `errored`: the cards that hold a problem right now; one that was not
 * in this set before is opened (once: the user can close it again while the problem stays).
 */
export function useCardState(defaults: Record<string, boolean>, errored: ReadonlySet<string>): CardState {
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [seenKey, setSeenKey] = useState("");
  const key = [...errored].sort().join("|");
  if (key !== seenKey) {
    const before = new Set(seenKey === "" ? [] : seenKey.split("|"));
    setSeenKey(key);
    const fresh = [...errored].filter((id) => !before.has(id));
    if (fresh.length > 0) setChosen((c) => ({ ...c, ...Object.fromEntries(fresh.map((id) => [id, true])) }));
  }
  return {
    isOpen: (id) => chosen[id] ?? defaults[id] ?? false,
    setOpen: (id, open) => setChosen((c) => ({ ...c, [id]: open })),
  };
}

/**
 * `testId` is the card's test id; the heading button is `${testId}-toggle`, the count badge `${testId}-count` (only when `count` > 0) and the
 * body `${testId}-body`. The body is not rendered while the card is closed.
 */
export function FormCard({ testId, title, count, open, onOpenChange, children }: {
  testId: string; title: string; count?: number; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode;
}) {
  const uid = useId();
  const headingId = `${uid}-heading`;
  const bodyId = `${uid}-body`;
  return (
    <section data-testid={testId} className="rounded-lg border border-border">
      <h3 id={headingId} className="text-body font-medium text-foreground">
        <button
          type="button" data-testid={`${testId}-toggle`} aria-expanded={open} aria-controls={bodyId} onClick={() => onOpenChange(!open)}
          className="flex w-full items-center gap-space-2 rounded-lg px-space-4 py-space-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {open ? <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
          <span>{title}</span>
          {count !== undefined && count > 0 && (
            <Badge variant="secondary">
              <span aria-hidden="true" data-testid={`${testId}-count`}>{count}</span>
              <span className="sr-only">{`${count} set`}</span>
            </Badge>
          )}
        </button>
      </h3>
      {open && (
        <div id={bodyId} data-testid={`${testId}-body`} role="region" aria-labelledby={headingId} className="space-y-space-4 border-t border-border p-space-4">
          {children}
        </div>
      )}
    </section>
  );
}
