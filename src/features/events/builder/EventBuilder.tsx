"use client";

// src/features/events/builder/EventBuilder.tsx
// The builder shell: outline (left), the selected section's form (middle) and a sticky Save / Discard bar. Sections read and write the
// document only through `draft` (`draft.update(fn)`), and show their own field errors from `draft.problems` + `draft.serverProblems`.
import { useMemo, type ComponentType } from "react";
import { Loader2, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { JsonObject } from "@/lib/event-specs/types";
import type { PropertySummaryRow } from "@/lib/events/bundled-traits";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
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

export function EventBuilder({ draft, options, section, onSectionChange, item, onItemChange }: {
  draft: DraftState;
  options: BuilderOptions;
  section: BuilderSection;
  onSectionChange: (section: BuilderSection) => void;
  item: string | null;
  onItemChange: (key: string | null) => void;
}) {
  const { doc, problems, serverProblems } = draft;
  const outline = useMemo(() => buildOutline(doc, uniqueProblems(problems.concat(serverProblems))), [doc, problems, serverProblems]);
  const failed = useMemo(() => uniqueProblems(serverProblems), [serverProblems]);
  const ActiveSection = SECTION_COMPONENTS[section];
  const busy = !draft.dirty || draft.saving;

  return (
    // `--builder-bar-h` is the height of the sticky Save bar and the bottom padding of the form above it: the last control always scrolls clear of the bar.
    <div data-testid="event-builder" className="grid gap-space-6 [--builder-bar-h:3.5rem] md:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="Event outline" data-testid="builder-outline" className="md:sticky md:top-space-4 md:self-start">
        <ul className="flex gap-space-1 overflow-x-auto md:flex-col">
          {outline.map((node) => {
            const isActive = node.section === section;
            return (
              <li key={node.section} className="shrink-0 md:shrink">
                <button
                  type="button" data-testid={`outline-${node.section}`} aria-current={isActive ? "true" : undefined}
                  onClick={() => { onSectionChange(node.section); onItemChange(null); }}
                  className={cn(
                    "flex w-full items-center justify-between gap-space-2 rounded-lg px-space-3 py-space-2 text-left text-body-small outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                    isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <span>{node.label}</span>
                  <span className="flex items-center gap-space-2">
                    {node.count !== null && (
                      <span data-testid={`outline-count-${node.section}`} className="text-caption text-muted-foreground">{node.count}</span>
                    )}
                    {node.problems > 0 && (
                      <Badge variant="destructive" data-testid={`outline-problems-${node.section}`}>
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

      <div className="min-w-0 space-y-space-6">
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

        <div data-testid="builder-form" className="pb-[var(--builder-bar-h)]">
          {ActiveSection ? (
            <ActiveSection draft={draft} options={options} selectedItem={item} onSelectItem={onItemChange} onSectionChange={onSectionChange} />
          ) : (
            <section data-testid="section-placeholder" className="space-y-space-1 rounded-lg border border-dashed border-border p-space-6 text-center">
              <h2 className="text-heading-3 text-foreground">{SECTION_LABELS[section]}</h2>
              <p className="text-body-small text-muted-foreground">Coming in the next slice.</p>
            </section>
          )}
        </div>

        <div data-testid="builder-bar" className="sticky bottom-0 z-10 flex h-[var(--builder-bar-h)] items-center justify-between gap-space-3 border-t border-border bg-background/95 backdrop-blur">
          <p role="status" data-testid="builder-status" className="flex items-center gap-space-2 text-body-small text-muted-foreground">
            {draft.dirty && !draft.saving && <span aria-hidden="true" className="size-2 rounded-full bg-warning" />}
            {draft.saving ? "Saving…" : draft.dirty ? "Unsaved changes" : "No unsaved changes"}
          </p>
          <div className="flex items-center gap-space-2">
            <Button type="button" variant="outline" onClick={draft.discard} disabled={busy} data-testid="builder-discard">Discard</Button>
            <Button type="button" onClick={() => { void draft.save(); }} disabled={busy} data-testid="builder-save" className="gap-1.5">
              {draft.saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save draft
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
