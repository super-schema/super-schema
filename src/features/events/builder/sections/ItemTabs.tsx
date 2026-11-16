"use client";

// src/features/events/builder/sections/ItemTabs.tsx
// The item picker of a list section (Messages, Channels, Operations, Servers) as a horizontal tab strip, in place of a 14rem column:
// the form beside it gets the whole width. The strip scrolls (edge fades and ‹ › buttons show when tabs are hidden), a search list (⌄)
// appears past six items, and the add button is pinned at the right, outside the scrolling part. A tab keeps the test id and the
// `aria-current` of the list row it replaces (`${prefix}-row-${key}`); the item's subtitle moves into the tab's `title`.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { scrollEdges } from "./tab-nav";
import { KeyInput } from "../controls";

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
export function ItemTabs({ label, prefix, items, activeIndex, onSelect, onAdd, addLabel = "Add", addTestId, addDisabled, addTitle, focusSignal, rename }: {
  label: string; prefix: string; items: ItemTab[]; activeIndex: number; onSelect: (key: string) => void;
  onAdd?: () => void; addLabel?: string; addTestId?: string; addDisabled?: boolean; addTitle?: string;
  /** A number the host raises to ask for the cursor to go to the active tab (after the item the user was in is removed). Not acted on at first render. */
  focusSignal?: number;
  /** Optional editing of the active tab's reference key, enabled only by the host that owns its rename operation. */
  rename?: { id: string; label: string; actionLabel: string; taken: string[]; error?: string; onCommit: (next: string) => void };
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const [edges, setEdges] = useState({ start: false, end: false });
  const [listOpen, setListOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const editing = !!rename && editingKey !== null && editingKey === items[activeIndex]?.key;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) {
      const input = editor.current?.querySelector("input");
      input?.focus();
      input?.select();
    } else if (wasEditing.current) {
      tabs.current[activeIndex]?.focus();
    }
    wasEditing.current = editing;
  }, [editing, activeIndex]);

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

  // Arrow keys, Home and End are the tabs list's; F2 starts the rename of the active tab.
  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (rename && index === activeIndex && e.key === "F2") {
      e.preventDefault();
      setEditingKey(items[index].key);
    }
  }

  const needle = query.trim().toLowerCase();
  // A tab shows a name or a title; the key (what problems and links name) is searchable too.
  const matches = items.map((item, index) => ({ item, index })).filter(({ item }) => needle === "" || `${tabName(item)} ${item.key}`.toLowerCase().includes(needle));
  const edgeButton = "absolute inset-y-0 z-10 h-auto w-6 rounded-none bg-background/90 px-0 text-muted-foreground hover:text-foreground";

  return (
    <div className="flex items-center gap-space-1 border-b border-border">
      <div className="relative min-w-0 flex-1">
        {edges.start && (
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Scroll ${label.toLowerCase()} left`} data-testid={`${prefix}-tabs-left`} onClick={() => scrollBy(-1)} className={cn(edgeButton, "left-0")}>
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Button>
        )}
        <div ref={scroller} onScroll={measure} className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Tabs
            value={activeIndex} className="gap-0"
            onValueChange={(value) => {
              const item = typeof value === "number" ? items[value] : undefined;
              if (!item) return;
              setEditingKey(null);
              onSelect(item.key);
            }}
          >
            <TabsList
              ref={strip} variant="line" activateOnFocus aria-label={label}
              className="h-auto w-max min-w-full justify-start gap-space-1 p-0 group-data-horizontal/tabs:h-auto"
            >
              {items.map((item, index) => {
                const isActive = index === activeIndex;
                if (isActive && editing && rename) return (
                  <div
                    key={index} ref={editor} className="w-64 shrink-0 px-space-2 py-space-1"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") { event.preventDefault(); setEditingKey(null); }
                    }}
                  >
                    <KeyInput
                      id={rename.id} label={rename.label} value={item.key} taken={rename.taken} error={rename.error}
                      onCommit={(next) => { rename.onCommit(next); setEditingKey(null); }}
                    />
                  </div>
                );
                return (
                  <TabsTrigger
                    key={index} value={index} ref={(el) => { tabs.current[index] = el; }}
                    data-testid={`${prefix}-row-${item.key}`} aria-current={isActive ? "true" : undefined}
                    title={`${tabName(item)} — ${item.subtitle}`}
                    onKeyDown={(e) => onTabKeyDown(e, index)}
                    onDoubleClick={rename ? () => setEditingKey(item.key) : undefined}
                    className="h-auto flex-none shrink-0 gap-space-2 px-3 py-2 group-data-horizontal/tabs:after:bottom-0"
                  >
                    <span data-testid={isActive && rename ? `${rename.id}-value` : undefined} className="max-w-[12rem] truncate">{tabName(item)}</span>
                    {item.broken && (
                      <>
                        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
                        <span className="sr-only">has problems</span>
                      </>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </div>
        {edges.end && (
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Scroll ${label.toLowerCase()} right`} data-testid={`${prefix}-tabs-right`} onClick={() => scrollBy(1)} className={cn(edgeButton, "right-0")}>
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
        )}
      </div>

      {rename && activeIndex >= 0 && !editing && (
        <Button
          type="button" size="icon-sm" variant="ghost" onClick={() => setEditingKey(items[activeIndex].key)}
          aria-label={rename.actionLabel} title={`${rename.actionLabel} (F2 or double-click the tab)`}
        >
          <Pencil aria-hidden="true" data-icon="inline-start" />
        </Button>
      )}

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
