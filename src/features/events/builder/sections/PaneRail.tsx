"use client";

// src/features/events/builder/sections/PaneRail.tsx
// The parts of one item (a message's Payload, Details, Examples, …) as a vertical rail of tabs with ONE part showing, in place of the
// accordion of stacked cards: the part being worked on gets the whole height. Below `@xl` (36rem) of the form's own width the rail is a
// row of scrolling pills above the part instead. A part is rendered the first time it is shown (and the ones named in `keepMounted`
// from the start) and then stays mounted, hidden when another part shows, so what it holds (focus order, a half-typed field's
// validation, an editor's state) is not rebuilt on every switch. Which part shows lives in `usePaneState`, kept by the SECTION so the
// choice survives switching from one item to another.
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { nextTabIndex } from "./tab-nav";

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
export function PaneRail({ idPrefix, panes, active, onSelect, keepMounted = [], label = "Parts" }: {
  idPrefix: string; panes: PaneDef[]; active: string; onSelect: (id: string) => void; keepMounted?: readonly string[]; label?: string;
}) {
  const uid = useId();
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(keepMounted));
  if (!visited.has(active)) setVisited(new Set([...visited, active]));
  const mounted = new Set([...visited, active]);
  const tabId = (id: string) => `${uid}-tab-${id}`;
  const panelId = (id: string) => `${uid}-panel-${id}`;

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    // A vertical rail answers up / down, the pills left / right.
    const key = e.key === "ArrowDown" ? "ArrowRight" : e.key === "ArrowUp" ? "ArrowLeft" : e.key;
    const to = nextTabIndex(index, panes.length, key);
    if (to === null) return;
    e.preventDefault();
    tabs.current[panes[to].id]?.focus();
    onSelect(panes[to].id);
  }

  return (
    <div data-testid={`${idPrefix}-rail`} className="@container">
      <div className="flex flex-col gap-space-4 @xl:grid @xl:grid-cols-[9rem_minmax(0,1fr)] @xl:items-start">
        <div role="tablist" aria-label={label} aria-orientation="vertical" className="flex gap-space-1 overflow-x-auto @xl:flex-col @xl:overflow-visible">
          {panes.map((pane, index) => {
            const isActive = pane.id === active;
            return (
              <button
                key={pane.id} id={tabId(pane.id)} ref={(el) => { tabs.current[pane.id] = el; }} type="button" role="tab"
                data-testid={`${idPrefix}-${pane.id}-toggle`} aria-selected={isActive} aria-controls={mounted.has(pane.id) ? panelId(pane.id) : undefined}
                tabIndex={isActive ? 0 : -1} onClick={() => onSelect(pane.id)} onKeyDown={(e) => onKeyDown(e, index)}
                className={cn(
                  "flex shrink-0 items-center gap-space-2 rounded-lg px-space-3 py-space-2 text-left text-body-small outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <span className="whitespace-nowrap">{pane.title}</span>
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
              </button>
            );
          })}
        </div>

        <div className="min-w-0">
          {panes.filter((pane) => mounted.has(pane.id)).map((pane) => (
            <div
              key={pane.id} id={panelId(pane.id)} role="tabpanel" aria-labelledby={tabId(pane.id)} data-testid={`${idPrefix}-${pane.id}-body`}
              hidden={pane.id !== active} className="space-y-space-4"
            >
              {pane.body}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
