"use client";

// src/features/events/builder/sections/ItemTabs.tsx
// The item picker of a list section (Messages, Channels, Operations, Servers) as a horizontal tab strip, in place of a 14rem column:
// the form beside it gets the whole width. The strip scrolls (edge fades and ‹ › buttons show when tabs are hidden), a search list (⌄)
// appears past six items, and the add button is pinned at the right, outside the scrolling part. A tab keeps the test id and the
// `aria-current` of the list row it replaces (`${prefix}-row-${key}`); the item's subtitle moves into the tab's `title`.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { nextTabIndex, scrollEdges } from "./tab-nav";

export interface ItemTab { key: string; label?: string; subtitle: string; broken: boolean }

/** From this many items on, the search list is offered. */
const SEARCH_FROM = 7;

const tabName = (item: ItemTab) => item.label || item.key || "(no key)";

/**
 * `label` names the tab list ("Messages"), `prefix` the test ids (`${prefix}-row-${key}`, `${prefix}-tabs-list`, `${prefix}-tabs-list-panel`).
 * Tabs are keyed by position: two items can share a (broken) key, and an item's key changes under the user (a key named on leaving the
 * form) without the tab, and the focus on it, being thrown away. `onAdd` absent hides the add button; `addDisabled` / `addTitle` are for
 * an add that cannot run yet (an operation needs a channel first).
 */
export function ItemTabs({ label, prefix, items, activeIndex, onSelect, onAdd, addLabel = "Add", addTestId, addDisabled, addTitle, focusSignal }: {
  label: string; prefix: string; items: ItemTab[]; activeIndex: number; onSelect: (key: string) => void;
  onAdd?: () => void; addLabel?: string; addTestId?: string; addDisabled?: boolean; addTitle?: string;
  /** A number the host raises to ask for the cursor to go to the active tab (after the item the user was in is removed). Not acted on at first render. */
  focusSignal?: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const [edges, setEdges] = useState({ start: false, end: false });
  const [listOpen, setListOpen] = useState(false);
  const [query, setQuery] = useState("");

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const next = scrollEdges(el);
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  // Measured when the strip or its scroller changes size (the observer also reports once on `observe`), and on scroll.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    if (scroller.current) observer.observe(scroller.current);
    if (strip.current) observer.observe(strip.current);
    return () => observer.disconnect();
  }, [measure]);

  // The host asks for the cursor on the active tab by raising `focusSignal`.
  const lastSignal = useRef(focusSignal);
  useEffect(() => {
    if (focusSignal === lastSignal.current) return;
    lastSignal.current = focusSignal;
    tabs.current[activeIndex]?.focus();
  }, [focusSignal, activeIndex]);

  // The active tab is brought into view, whatever selected it (a click in the search list, the add button, a deep link).
  useEffect(() => {
    tabs.current[activeIndex]?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [activeIndex, items.length]);

  function scrollBy(direction: -1 | 1) {
    const el = scroller.current;
    el?.scrollBy?.({ left: direction * Math.max(120, el.clientWidth * 0.6), behavior: "smooth" });
  }

  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const to = nextTabIndex(index, items.length, e.key);
    if (to === null) return;
    e.preventDefault();
    tabs.current[to]?.focus();
    onSelect(items[to].key);
  }

  const needle = query.trim().toLowerCase();
  // A tab shows a name or a title; the key (what problems and links name) is searchable too.
  const matches = items.map((item, index) => ({ item, index })).filter(({ item }) => needle === "" || `${tabName(item)} ${item.key}`.toLowerCase().includes(needle));
  const edgeButton = "absolute inset-y-0 z-10 flex w-6 items-center justify-center bg-background/90 text-muted-foreground hover:text-foreground";

  return (
    <div className="flex items-center gap-space-1 border-b border-border">
      <div className="relative min-w-0 flex-1">
        {edges.start && (
          <button type="button" aria-label={`Scroll ${label.toLowerCase()} left`} data-testid={`${prefix}-tabs-left`} onClick={() => scrollBy(-1)} className={cn(edgeButton, "left-0")}>
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
        )}
        <div ref={scroller} onScroll={measure} className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div ref={strip} role="tablist" aria-label={label} className="flex w-max min-w-full items-center gap-space-1">
            {items.map((item, index) => {
              const isActive = index === activeIndex;
              return (
                <button
                  key={index} ref={(el) => { tabs.current[index] = el; }} type="button" role="tab"
                  data-testid={`${prefix}-row-${item.key}`} aria-selected={isActive} aria-current={isActive ? "true" : undefined}
                  tabIndex={isActive ? 0 : -1} title={`${tabName(item)} — ${item.subtitle}`}
                  onClick={() => onSelect(item.key)} onKeyDown={(e) => onTabKeyDown(e, index)}
                  className={cn(
                    "flex shrink-0 items-center gap-space-2 border-b-2 px-space-3 py-space-2 text-body-small outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                    isActive ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="max-w-[12rem] truncate">{tabName(item)}</span>
                  {item.broken && (
                    <>
                      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
                      <span className="sr-only">has problems</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {edges.end && (
          <button type="button" aria-label={`Scroll ${label.toLowerCase()} right`} data-testid={`${prefix}-tabs-right`} onClick={() => scrollBy(1)} className={cn(edgeButton, "right-0")}>
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>

      {items.length >= SEARCH_FROM && (
        <Popover open={listOpen} onOpenChange={(open) => { setListOpen(open); if (!open) setQuery(""); }}>
          <PopoverTrigger
            type="button" data-testid={`${prefix}-tabs-list`} aria-label={`Find in ${label.toLowerCase()}`} title={`Find in ${label.toLowerCase()}`}
            className={buttonVariants({ size: "icon-sm", variant: "ghost", className: "shrink-0 text-muted-foreground" })}
          >
            <ChevronDown aria-hidden="true" className="size-4" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)] gap-0 p-0" data-testid={`${prefix}-tabs-list-panel`}>
            <Command shouldFilter={false} aria-label={`Find in ${label.toLowerCase()}`}>
              <CommandInput value={query} onValueChange={setQuery} placeholder={`Find in ${label.toLowerCase()}…`} />
              <CommandList>
                {matches.map(({ item, index }) => (
                  <CommandItem key={`${index}-${item.key}`} value={`${index}-${item.key}`} onSelect={() => { onSelect(item.key); setListOpen(false); }}>
                    {tabName(item)}
                    {item.key !== "" && tabName(item) !== item.key && <span className="ml-auto truncate pl-space-2 text-caption text-muted-foreground">{item.key}</span>}
                    {item.broken && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />}
                  </CommandItem>
                ))}
              </CommandList>
              {matches.length === 0 && <p className="px-space-3 py-space-4 text-center text-body-small text-muted-foreground">No match</p>}
            </Command>
          </PopoverContent>
        </Popover>
      )}

      {onAdd && (
        <Button
          type="button" size="icon-sm" variant="ghost" onClick={onAdd} disabled={addDisabled} data-testid={addTestId}
          aria-label={addLabel} title={addTitle ?? addLabel} className="shrink-0"
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      )}
    </div>
  );
}
