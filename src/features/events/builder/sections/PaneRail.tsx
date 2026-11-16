"use client";

// src/features/events/builder/sections/PaneRail.tsx
// The parts of one item (a message's Payload, Details, Examples, …) as a vertical rail of tabs with ONE part showing, in place of the
// accordion of stacked cards: the part being worked on gets the whole height. Below `@xl` (36rem) of the form's own width the rail is a
// row of pills above the part instead; the row wraps (never scrolls sideways), so the last part (Metadata) is always in view. A part is rendered the first time it is shown (and the ones named in `keepMounted`,
// and the ones that hold a problem, from the start) and then stays mounted, hidden when another part shows, so what it holds (focus order, a half-typed field's
// validation, an editor's state) is not rebuilt on every switch. Which part shows lives in `usePaneState`, kept by the SECTION so the
// choice survives switching from one item to another.
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { NativeSelect } from "@/components/ui/native-select";
export interface PaneState {
  active: string;
  select: (id: string) => void;
}

/**
 * `defaultPane` shows until the user picks one. `errored`: the panes that hold a problem right now, in the order they should win; a pane
 * that was not in this set before is shown (once: the user can leave it while the problem stands, and the first of several wins).
 */
export function usePaneState(defaultPane: string, errored: ReadonlySet<string>): PaneState {
  const [chosen, setChosen] = useState<string | null>(null);
  const [seenKey, setSeenKey] = useState("");
  const key = [...errored].join("|");
  if (key !== seenKey) {
    const before = new Set(seenKey === "" ? [] : seenKey.split("|"));
    setSeenKey(key);
    const fresh = [...errored].find((id) => !before.has(id));
    if (fresh !== undefined) setChosen(fresh);
  }
  return { active: chosen ?? defaultPane, select: setChosen };
}

export interface PaneDef {
  id: string;
  title: string;
  /** How many fields are set; shown as a badge when above zero. */
  count?: number;
  /** The pane holds a problem: a red dot on its tab. */
  broken?: boolean;
  body: ReactNode;
}

/**
 * `idPrefix` builds the test ids: the tab is `${idPrefix}-${id}-toggle`, its count `…-count`, the panel `…-body` and the wrapper
 * `${idPrefix}-rail`. `label` names the tab list.
 */
export function PaneRail({ idPrefix, panes, active: requestedActive, onSelect, keepMounted = [], label = "Parts", corePanes }: {
  idPrefix: string; panes: PaneDef[]; active: string; onSelect: (id: string) => void; keepMounted?: readonly string[]; label?: string;
  /** Show core sections as horizontal tabs; other sections are added on demand, or shown when populated / invalid. */
  corePanes?: readonly string[];
}) {
  // Optional panes can disappear when their last value is removed.
  const active = panes.some((pane) => pane.id === requestedActive) ? requestedActive : panes[0]?.id;
  useEffect(() => {
    if (active !== undefined && active !== requestedActive) onSelect(active);
  }, [active, requestedActive, onSelect]);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const visible = corePanes
    ? panes.filter((pane) => corePanes.includes(pane.id) || added.has(pane.id) || pane.id === active || (pane.count ?? 0) > 0 || pane.broken)
    : panes;
  const available = panes.filter((pane) => !visible.includes(pane));
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(keepMounted));
  if (active !== undefined && !visited.has(active)) setVisited(new Set([...visited, active]));
  // A pane that holds a problem is built even when it is not showing: its error text must be in the page, and its tab says where to look.
  const mounted = new Set([...visited, active, ...panes.filter((pane) => pane.broken).map((pane) => pane.id)]);

  // The tabs list answers left / right (and Home / End) itself. The rail also answers up / down, which it hands on as left / right.
  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (corePanes || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    e.target.dispatchEvent(new KeyboardEvent("keydown", { key: e.key === "ArrowDown" ? "ArrowRight" : "ArrowLeft", bubbles: true, cancelable: true }));
  }

  return (
    <div data-testid={`${idPrefix}-rail`} className="@container">
      <Tabs
        value={active ?? null} onValueChange={(id) => { if (typeof id === "string") onSelect(id); }}
        className={cn("flex-col gap-space-4", !corePanes && "@xl:grid @xl:grid-cols-[9rem_minmax(0,1fr)] @xl:items-start")}
      >
        <div className="flex min-w-0 flex-wrap items-start gap-space-2">
        <TabsList
          variant="line" activateOnFocus aria-label={label} aria-orientation={corePanes ? "horizontal" : "vertical"} onKeyDown={onListKeyDown}
          className={cn(
            "h-auto min-w-0 flex-wrap justify-start gap-space-1 p-0 group-data-horizontal/tabs:h-auto",
            !corePanes && "@xl:flex-col @xl:flex-nowrap",
          )}
        >
          {visible.map((pane) => (
              <TabsTrigger
                key={pane.id} value={pane.id}
                data-testid={`${idPrefix}-${pane.id}-toggle`}
                className={cn(
                  "h-auto flex-none shrink-0 justify-start gap-space-2 px-3 py-2 text-left group-data-horizontal/tabs:after:bottom-0",
                  !corePanes && "@xl:w-full",
                )}
              >
                <span className="whitespace-nowrap @xl:whitespace-normal">{pane.title}</span>
                {pane.count !== undefined && pane.count > 0 && (
                  <Badge variant="secondary">
                    <span aria-hidden="true" data-testid={`${idPrefix}-${pane.id}-count`}>{pane.count}</span>
                    <span className="sr-only">{`${pane.count} set`}</span>
                  </Badge>
                )}
                {pane.broken && (
                  <>
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
                    <span className="sr-only">has problems</span>
                  </>
                )}
              </TabsTrigger>
          ))}
        </TabsList>
        {corePanes && available.length > 0 && (
          <NativeSelect
            aria-label="Add section" data-testid={idPrefix + "-add-section"} value=""
            className="ml-auto w-auto max-w-full"
            onChange={(event) => {
              const id = event.target.value;
              if (!id) return;
              setAdded((before) => new Set([...before, id]));
              onSelect(id);
            }}
          >
            <option value="" disabled>Add section…</option>
            {available.map((pane) => <option key={pane.id} value={pane.id}>{pane.title}</option>)}
          </NativeSelect>
        )}
        </div>

        <div className="min-w-0">
          {panes.filter((pane) => mounted.has(pane.id)).map((pane) => (
            <TabsContent key={pane.id} value={pane.id} keepMounted data-testid={`${idPrefix}-${pane.id}-body`} className="flex-none space-y-space-4 text-[length:inherit]">
              {pane.body}
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </div>
  );
}
