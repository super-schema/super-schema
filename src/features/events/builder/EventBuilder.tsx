"use client";

// src/features/events/builder/EventBuilder.tsx
// The builder shell: outline (left), the selected section's form (middle) and a sticky Save / Discard bar. Sections read and write the
// document only through `draft` (`draft.update(fn)`), and show their own field errors from `draft.problems` + `draft.serverProblems`.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { Info, Loader2, MessageSquare, Network, PanelLeftClose, PanelLeftOpen, Save, Search, Server, Settings2, Tags, Workflow, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { JsonObject } from "@/lib/event-specs/types";
import type { PropertySummaryRow } from "@/lib/events/bundled-traits";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { jumpEntries } from "./jump";
import { JumpPalette } from "./JumpPalette";
import { buildOutline, SECTION_LABELS } from "./outline";
import { locateProblem, uniqueProblems } from "./problems";
import { AdvancedSection } from "./sections/AdvancedSection";
import { ChannelsSection } from "./sections/ChannelsSection";
import { MessagesSection } from "./sections/MessagesSection";
import { MetadataSection } from "./sections/MetadataSection";
import { OperationsSection } from "./sections/OperationsSection";
import { PropertiesSection } from "./sections/PropertiesSection";
import { ServersSection } from "./sections/ServersSection";
import type { BuilderSection } from "./sections";
import type { DraftState } from "./use-event-draft";

/**
 * A trait of the Tenant / Domain library that an event can use (`traits[].libraryTraitId`). `level` is where it is defined ("Enterprise", "Domain · Payments").
 * `spec`, `bundled` and `properties` come from the stored trait (`loadTraitOptions`): the instant code emits `spec` as it is, `bundled` marks a built-in
 * (read-only, shown locked) and `properties` is the table of its inline message properties (`propertySummary`). All three are absent when the host does not know them.
 */
export interface LibraryTraitOption {
  id: string; name: string; kind: "MESSAGE" | "OPERATION"; level?: string;
  spec?: JsonObject; bundled?: boolean; properties?: PropertySummaryRow[];
}

/** Icons of the outline in its compact (icons only) form. */
const SECTION_ICONS: Record<BuilderSection, LucideIcon> = {
  metadata: Info, servers: Server, channels: Network, messages: MessageSquare, operations: Workflow, traits: Tags, advanced: Settings2,
};

/** `auto`: the pane's width decides (CSS container queries). `open` / `compact`: the user's choice, kept in `localStorage`. */
type OutlineMode = "auto" | "open" | "compact";
const OUTLINE_KEY = "events-builder-outline";
/** The container width (48rem = Tailwind's `@3xl`) from which an undecided outline shows its labels. */
const OUTLINE_WIDE_PX = 768;

/** Classes per mode. Below `@lg` (32rem) the outline is a scrolling row above the form whatever the mode. Written out, not computed, so Tailwind sees them. */
const OUTLINE_GRID: Record<OutlineMode, string> = {
  auto: "grid-cols-1 @lg:grid-cols-[3rem_minmax(0,1fr)] @3xl:grid-cols-[13rem_minmax(0,1fr)]",
  open: "grid-cols-1 @lg:grid-cols-[13rem_minmax(0,1fr)]",
  compact: "grid-cols-1 @lg:grid-cols-[3rem_minmax(0,1fr)]",
};
/** In the icons-only form a problem badge sits on the icon's corner and the item is centred. */
const OUTLINE_BADGE: Record<OutlineMode, string> = {
  auto: "absolute -right-1 -top-1 @max-lg:static @3xl:static",
  open: "",
  compact: "absolute -right-1 -top-1 @max-lg:static",
};
const OUTLINE_BUTTON: Record<OutlineMode, string> = {
  auto: "@lg:justify-center @3xl:justify-between",
  open: "",
  compact: "@lg:justify-center",
};
const OUTLINE_LABEL: Record<OutlineMode, string> = {
  auto: "sr-only @max-lg:not-sr-only @3xl:not-sr-only",
  open: "",
  compact: "sr-only @max-lg:not-sr-only",
};

const noSubscription = () => () => {};
const serverOutlineMode = (): OutlineMode => "auto";

function readOutlineMode(): OutlineMode {
  try {
    const stored = localStorage.getItem(OUTLINE_KEY);
    return stored === "open" || stored === "compact" ? stored : "auto";
  } catch {
    return "auto";
  }
}

export interface BuilderOptions { entityOptions: EntityOption[]; libraryTraits: LibraryTraitOption[] }

export interface SectionProps {
  draft: DraftState;
  options: BuilderOptions;
  /** Local key of the item the user is editing (deep-link `?item=`), or null. */
  selectedItem: string | null;
  onSelectItem: (key: string | null) => void;
  /** Lets a section send the user to another one (Operations: "Add a channel first"). Absent when the host cannot switch. */
  onSectionChange?: (section: BuilderSection) => void;
}

/** Which component renders each section. A section without an entry shows the placeholder. */
export const SECTION_COMPONENTS: Partial<Record<BuilderSection, ComponentType<SectionProps>>> = {
  metadata: MetadataSection,
  servers: ServersSection,
  channels: ChannelsSection,
  messages: MessagesSection,
  operations: OperationsSection,
  traits: PropertiesSection,
  advanced: AdvancedSection,
};

export function EventBuilder({ draft, options, section, onSectionChange, item, onItemChange, active = true }: {
  draft: DraftState;
  options: BuilderOptions;
  section: BuilderSection;
  onSectionChange: (section: BuilderSection) => void;
  item: string | null;
  onItemChange: (key: string | null) => void;
  /** False while the Design tab is hidden: the builder stays mounted (its draft lives here) but must not answer shortcuts. */
  active?: boolean;
}) {
  const { doc, problems, serverProblems } = draft;
  const outline = useMemo(() => buildOutline(doc, uniqueProblems(problems.concat(serverProblems))), [doc, problems, serverProblems]);
  const failed = useMemo(() => uniqueProblems(serverProblems), [serverProblems]);
  const ActiveSection = SECTION_COMPONENTS[section];
  const busy = !draft.dirty || draft.saving;
  const allProblems = useMemo(() => uniqueProblems(problems.concat(serverProblems)), [problems, serverProblems]);

  // Mod+S saves. While the Design tab shows it always takes the key from the browser (a "save page" dialog is never what is meant),
  // and saves when there is something to save and no save is running. While the tab is hidden the builder stays out of it.
  const { dirty, saving, save } = draft;
  useEffect(() => {
    if (!active) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (dirty && !saving) void save();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, dirty, saving, save]);

  // Mod+J opens the jump palette (Mod+K is the app's own palette and is left alone). Like Mod+S it is answered only while the tab shows.
  const [jumpOpen, setJumpOpen] = useState(false);
  const jumpList = useMemo(() => jumpEntries(outline), [outline]);
  useEffect(() => {
    if (!active) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "j") return;
      e.preventDefault();
      setJumpOpen((open) => !open);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);

  function goToFirstProblem() {
    const first = allProblems[0];
    if (!first) return;
    const { section: target, item: targetItem } = locateProblem(doc, first.pointer);
    if (target === null) return;
    onSectionChange(target);
    onItemChange(targetItem);
  }

  // The remembered choice is a client-only value: the server render (and hydration) see `auto`, the client then reads the stored choice.
  // A choice made on this page wins at once, even where storage is blocked.
  const stored = useSyncExternalStore(noSubscription, readOutlineMode, serverOutlineMode);
  const [chosen, setChosen] = useState<OutlineMode | null>(null);
  const mode = chosen ?? stored;
  const rootRef = useRef<HTMLDivElement>(null);
  function toggleOutline() {
    // An undecided outline shows what its width gives it: from the measured width, the toggle goes to the other form.
    const wide = (rootRef.current?.offsetWidth ?? 0) >= OUTLINE_WIDE_PX;
    const showing: OutlineMode = mode === "auto" ? (wide ? "open" : "compact") : mode;
    const next: OutlineMode = showing === "compact" ? "open" : "compact";
    setChosen(next);
    try { localStorage.setItem(OUTLINE_KEY, next); } catch { /* storage blocked: the choice lasts for this page only */ }
  }

  return (
    <div ref={rootRef} data-testid="event-builder" data-outline={mode === "auto" ? undefined : mode} className="@container">
      <div className={cn("grid gap-space-6", OUTLINE_GRID[mode])}>
        <div className="@lg:sticky @lg:top-space-4 @lg:self-start">
          <nav aria-label="Event outline" data-testid="builder-outline">
            <ul className="flex gap-space-1 overflow-x-auto @lg:flex-col">
              {outline.map((node) => {
                const isActive = node.section === section;
                const Icon = SECTION_ICONS[node.section];
                return (
                  <li key={node.section} className="shrink-0 @lg:shrink">
                    <button
                      type="button" data-testid={`outline-${node.section}`} aria-current={isActive ? "true" : undefined} title={node.label}
                      onClick={() => { onSectionChange(node.section); onItemChange(null); }}
                      className={cn(
                        "relative flex w-full items-center justify-between gap-space-2 rounded-lg px-space-3 py-space-2 text-left text-body-small outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                        OUTLINE_BUTTON[mode],
                        isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-space-2">
                        <Icon aria-hidden="true" className="size-4 shrink-0" />
                        <span className={OUTLINE_LABEL[mode]}>{node.label}</span>
                      </span>
                      <span className="flex items-center gap-space-2">
                        {node.count !== null && (
                          <span data-testid={`outline-count-${node.section}`} className={cn("text-caption text-muted-foreground", OUTLINE_LABEL[mode])}>{node.count}</span>
                        )}
                        {node.problems > 0 && (
                          <Badge variant="destructive" data-testid={`outline-problems-${node.section}`} className={OUTLINE_BADGE[mode]}>
                            <span aria-hidden="true">{node.problems}</span>
                            <span className="sr-only">{node.problems === 1 ? "problem" : "problems"}</span>
                          </Badge>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <Button
            type="button" variant="ghost" size="sm" onClick={() => setJumpOpen(true)} data-testid="jump-open" title="Jump to a section or item (⌘J, or Ctrl+J)"
            className="mt-space-2 w-full justify-center gap-space-2 text-muted-foreground @lg:justify-between"
          >
            <span className="flex items-center gap-space-2">
              <Search aria-hidden="true" className="size-4 shrink-0" />
              <span className={OUTLINE_LABEL[mode]}>Jump to…</span>
            </span>
            <kbd className={cn("rounded border border-border px-1 text-caption", OUTLINE_LABEL[mode])}>⌘J</kbd>
          </Button>
          <Button
            type="button" variant="ghost" size="icon-sm" onClick={toggleOutline} data-testid="outline-toggle"
            aria-pressed={mode === "compact"} aria-label="Compact outline" title="Compact outline" className="mt-space-2 hidden text-muted-foreground @lg:inline-flex"
          >
            {mode === "compact" ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}
          </Button>
        </div>

        <div data-testid="builder-content" className="@container min-w-0 space-y-space-6">
          {draft.error && (
            <div role="alert" data-testid="builder-error" className="space-y-space-2 rounded-lg border border-destructive/30 bg-destructive/5 p-space-3 text-body-small text-destructive">
              <p>{draft.error}</p>
              {failed.length > 0 && (
                <ul className="max-h-48 list-disc space-y-space-1 overflow-y-auto pl-space-4">
                  {failed.map((p) => {
                    const { section: target, item: targetItem } = locateProblem(doc, p.pointer);
                    if (target === null) return <li key={`${p.pointer}|${p.message}`}>{`${p.pointer === "" ? "document" : p.pointer}: ${p.message}`}</li>;
                    const label = `${SECTION_LABELS[target]}${targetItem ? ` · ${targetItem}` : ""}: ${p.message}`;
                    return (
                      <li key={`${p.pointer}|${p.message}`}>
                        <button
                          type="button" className="text-left underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-ring/50"
                          onClick={() => { onSectionChange(target); onItemChange(targetItem); }}
                        >{label}</button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {ActiveSection ? (
            <ActiveSection draft={draft} options={options} selectedItem={item} onSelectItem={onItemChange} onSectionChange={onSectionChange} />
          ) : (
            <section data-testid="section-placeholder" className="space-y-space-1 rounded-lg border border-dashed border-border p-space-6 text-center">
              <h2 className="text-heading-3 text-foreground">{SECTION_LABELS[section]}</h2>
              <p className="text-body-small text-muted-foreground">Coming in the next slice.</p>
            </section>
          )}

          <div data-testid="builder-bar" className="sticky bottom-0 z-10 flex items-center justify-between gap-space-3 border-t border-border bg-background/95 py-space-3 backdrop-blur">
            <div className="flex items-center gap-space-3">
              <p role="status" data-testid="builder-status" className="flex items-center gap-space-2 text-body-small text-muted-foreground">
                {draft.dirty && !draft.saving && <span aria-hidden="true" className="size-2 rounded-full bg-warning" />}
                {draft.saving ? "Saving…" : draft.dirty ? "Unsaved changes" : "No unsaved changes"}
              </p>
              {allProblems.length > 0 && (
                <button
                  type="button" data-testid="builder-problems" onClick={goToFirstProblem} title="Go to the first problem"
                  className="rounded-md text-body-small text-destructive underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {allProblems.length === 1 ? "1 problem" : `${allProblems.length} problems`}
                </button>
              )}
            </div>
            <div className="flex items-center gap-space-2">
              <Button type="button" variant="outline" onClick={draft.discard} disabled={busy} data-testid="builder-discard">Discard</Button>
              <Button type="button" onClick={() => { void draft.save(); }} disabled={busy} data-testid="builder-save" className="gap-1.5">
                {draft.saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save draft
              </Button>
            </div>
          </div>
        </div>
      </div>
      <JumpPalette
        open={jumpOpen} onOpenChange={setJumpOpen} entries={jumpList}
        onJump={(entry) => { onSectionChange(entry.section); onItemChange(entry.item); }}
      />
    </div>
  );
}
