"use client";

// src/features/events/builder/sections/PropertiesSection.tsx
// Message properties (Trait): reusable sets of properties that messages and operations pick up. AsyncAPI calls them traits; the user sees
// "Message properties" with "(Trait)" in brackets (labels.ts).
//
//   One primary "+ Add" (PropertiesChooser): Applies to Message | Operation, a search, then Built in / Library / New (blank). A built-in or
//   library choice is added at once (a library entry `{ key, kind, libraryTraitId }` under a key made from its name; an entry the event already
//   has is reused) and selected; "New (blank)" adds a local set with a placeholder key and focuses its name. No key field, no kind form.
//
//   A set is LOCAL (its properties are a Properties table that writes `spec.headers`, the rest is under a collapsed "More details") or from the
//   Tenant / Domain LIBRARY, built-in ones included (read-only here: the table is shown with a lock, it is edited where it is defined).
//   Messages and operations pick sets by key (`traitKeys`); this section owns the sets themselves. The key is generated from the name or title
//   once the user leaves the form; the "Identifier" below the form (local sets only) is the only place it shows. Removing a set that is used
//   asks first and takes it off every message and operation that carries it.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Lock, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { JsonObject, TraitKind } from "@/lib/event-specs/types";
import { renameKey } from "@/lib/events/document/keys";
import { isLibraryTrait, type DocTrait, type DocumentProblem, type EventDocument } from "@/lib/events/document/types";
import { TEMPLATES } from "@/lib/events/templates";
import { leftForm } from "../auto-key";
import type { LibraryTraitOption, SectionProps } from "../EventBuilder";
import { IdentifierDisclosure } from "../Identifier";
import {
  BUILT_IN_BADGE, BUILT_IN_NOTE, builtInExplanation, groupLabel, LIBRARY_BADGE, LIBRARY_NOTE, MESSAGE_PROPERTIES, propertiesName, propertiesNameLower, propertiesTitle,
  propertyCountText, TRAIT_BADGE, TRAIT_SUFFIX,
} from "../labels";
import { problemMessage, problemsByField, uniqueProblems } from "../problems";
import { buildReferenceContext } from "../references";
import { BindingsForm, TemplateForm, type TemplateFormContext } from "../template";
import { isEmptyValue, setField } from "../template/value";
import {
  addChoice, autoNameTrait, isBuiltInEntry, optionOf, removeTrait, traitHeaders, traitLabel, traitPropertyCount, traitUsage, usageText, type TraitChoice,
} from "../traits";
import type { DraftState } from "../use-event-draft";
import { bindingCount, cardTemplate, pickValue, setFieldCount } from "./form-cards";
import { PropertiesChooser } from "./PropertiesChooser";
import { LockedNote, PropertiesTable } from "./PropertiesTable";

type LocalTrait = Extract<DocTrait, { spec: JsonObject }>;
type LibraryTrait = Extract<DocTrait, { libraryTraitId: string }>;

const KINDS: TraitKind[] = ["MESSAGE", "OPERATION"];
const NO_LIBRARY: LibraryTraitOption[] = [];

/** The template fields a local set shows up front (its identity), and the ones under "More details", per kind. The bindings have a form of their own. */
const PRIMARY_KEYS: Record<TraitKind, string[]> = { MESSAGE: ["name"], OPERATION: ["title", "summary", "description"] };
const MORE_KEYS: Record<TraitKind, string[]> = {
  MESSAGE: ["title", "summary", "description", "contentType", "correlationId", "examples", "tags", "externalDocs", "deprecated"],
  OPERATION: ["security", "tags", "externalDocs"],
};
const templateOf = (kind: TraitKind) => (kind === "MESSAGE" ? TEMPLATES.messageTrait : TEMPLATES.operationTrait);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const omit = (spec: JsonObject, key: string): JsonObject => {
  const next = { ...spec };
  delete next[key];
  return next;
};

export function PropertiesSection({ draft, options, selectedItem, onSelectItem }: SectionProps) {
  const { doc, update } = draft;
  const traits = doc.traits;
  const library = options.libraryTraits ?? NO_LIBRARY;
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = useMemo(() => uniqueProblems(draft.problems.concat(draft.serverProblems)), [draft.problems, draft.serverProblems]);
  const context = useMemo(() => buildReferenceContext(doc, { entityOptions: options.entityOptions }), [doc, options.entityOptions]);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // List order is by group (on messages, then on operations); the form follows the selected key, else the first row.
  const entries = traits.map((trait, index) => ({ trait, index }));
  const grouped = KINDS.map((kind) => ({ kind, entries: entries.filter((e) => e.trait.kind === kind) }));
  const ordered = grouped.flatMap((g) => g.entries);
  const active = (selectedItem === null ? undefined : ordered.find((e) => e.trait.key === selectedItem)) ?? ordered[0] ?? null;
  const usedLibraryIds = traits.flatMap((t) => (isLibraryTrait(t) ? [t.libraryTraitId] : []));

  function choose(choice: TraitChoice) {
    const { key } = addChoice(doc, choice);
    update((d) => addChoice(d, choice).doc);
    onSelectItem(key);
    if (choice.type === "blank") setFocusKey(key);
  }

  return (
    <section aria-labelledby="traits-heading" data-testid="section-traits" className="space-y-space-6">
      <header className="flex items-start justify-between gap-space-4">
        <div className="space-y-space-1">
          <h2 id="traits-heading" className="text-heading-3 text-foreground">
            {MESSAGE_PROPERTIES} <span className="font-normal text-muted-foreground">{TRAIT_SUFFIX}</span>
          </h2>
          <p className="text-body-small text-muted-foreground">
            Reusable sets of properties that messages and operations pick up: a built-in one such as CloudEvents, one from the Tenant or Domain library, or your own.
          </p>
        </div>
        <PropertiesChooser
          library={library} usedIds={usedLibraryIds} onChoose={choose} triggerTestId="trait-add" triggerLabel="Add message or operation properties"
        />
      </header>

      {!active ? (
        <div data-testid="trait-empty" className="space-y-space-1 rounded-lg border border-dashed border-border p-space-6 text-center">
          <p className="text-heading-3 text-foreground">No message properties yet</p>
          <p className="text-body-small text-muted-foreground">
            They are optional. Use Add to apply a built-in set such as CloudEvents, pick one from the library, or start a new one.
          </p>
        </div>
      ) : (
        <div className="grid gap-space-6 md:grid-cols-[14rem_1fr]">
          <div className="space-y-space-4">
            {grouped.map(({ kind, entries: rows }) => {
              const lower = kind.toLowerCase();
              return (
                <div key={kind} data-testid={`trait-group-${lower}`} className="space-y-space-1">
                  <h3 className="px-space-3 text-caption font-medium text-muted-foreground">{groupLabel(kind)}</h3>
                  {rows.length === 0 ? (
                    <p data-testid={`trait-group-${lower}-empty`} className="px-space-3 text-caption text-muted-foreground">None yet.</p>
                  ) : (
                    <ul aria-label={groupLabel(kind)} className="space-y-space-1">
                      {rows.map(({ trait, index }) => {
                        const isActive = index === active.index;
                        const broken = problemsByField(problems, `/traits/${index}`).length > 0;
                        const count = traitPropertyCount(trait, library);
                        const builtIn = isBuiltInEntry(trait, library);
                        const usage = usageText(trait.kind, traitUsage(doc, trait.key));
                        return (
                          <li key={`${index}-${trait.key}`}>
                            <button
                              type="button" data-testid={`trait-row-${trait.key}`} aria-current={isActive ? "true" : undefined}
                              onClick={() => onSelectItem(trait.key)}
                              className={cn(
                                "flex w-full items-center justify-between gap-space-2 rounded-lg px-space-3 py-space-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                                isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                              )}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-body-small font-medium">{traitLabel(trait, library)}</span>
                                <span className="block truncate text-caption text-muted-foreground">
                                  {count !== null && count > 0 ? `${usage} · ${propertyCountText(count)}` : usage}
                                </span>
                              </span>
                              <span className="flex shrink-0 flex-col items-end gap-space-1">
                                <Badge variant="outline" data-testid={`trait-row-${trait.key}-badge`}>{TRAIT_BADGE}</Badge>
                                {isLibraryTrait(trait) && (
                                  <Badge variant="secondary" data-testid={`trait-row-${trait.key}-library`} className="gap-1">
                                    <Lock aria-hidden="true" />
                                    {builtIn ? BUILT_IN_BADGE : LIBRARY_BADGE}
                                  </Badge>
                                )}
                                {broken && (
                                  <>
                                    <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
                                    <span className="sr-only">has problems</span>
                                  </>
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          {isLibraryTrait(active.trait) ? (
            <LibraryItem
              key={active.index} draft={draft} index={active.index} trait={active.trait} library={library}
              problems={problems} onSelectItem={onSelectItem}
            />
          ) : (
            <LocalForm
              key={active.index} draft={draft} index={active.index} trait={active.trait} problems={problems} context={context}
              entityOptions={options.entityOptions} focusName={focusKey === active.trait.key} onFocused={() => setFocusKey(null)} onSelectItem={onSelectItem}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** "Used by 2 messages" for the set, with the keys of the users listed for the tooltip. */
function UsageLine({ doc, trait }: { doc: EventDocument; trait: DocTrait }) {
  const usage = traitUsage(doc, trait.key);
  const users = [...usage.messages, ...usage.operations];
  return (
    <p data-testid="trait-usage" title={users.length > 0 ? users.join(", ") : undefined} className="text-body-small text-muted-foreground">
      {usageText(trait.kind, usage)}
    </p>
  );
}

/** Remove the set at `index`. A set in use asks first, then leaves the messages and operations that carried it. */
function removeWithConfirm(draft: DraftState, index: number, label: string, onSelectItem: (key: string | null) => void) {
  const trait = draft.doc.traits[index];
  if (!trait) return;
  const usage = traitUsage(draft.doc, trait.key);
  const count = usage.messages.length + usage.operations.length;
  if (count > 0) {
    const where = [
      usage.messages.length > 0 ? `${plural(usage.messages.length, "message")} (${usage.messages.join(", ")})` : null,
      usage.operations.length > 0 ? `${plural(usage.operations.length, "operation")} (${usage.operations.join(", ")})` : null,
    ].filter(Boolean).join(" and ");
    if (!window.confirm(`${propertiesName(trait.kind)} "${label}" is used by ${where}. Remove it and take it off ${count === 1 ? "that item" : "those items"}?`)) return;
  }
  draft.update((d) => removeTrait(d, index));
  onSelectItem(null);
}

function RemoveButton({ kind, library, onClick }: { kind: TraitKind; library?: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-end">
      <Button type="button" variant="outline" onClick={onClick} data-testid="trait-remove" className="gap-1.5 text-muted-foreground hover:text-destructive">
        <Trash2 className="size-4" /> {library ? "Remove from this event" : `Remove ${propertiesNameLower(kind)}`}
      </Button>
    </div>
  );
}

function LocalForm({ draft, index, trait, problems, context, entityOptions, focusName, onFocused, onSelectItem }: {
  draft: DraftState; index: number; trait: LocalTrait; problems: DocumentProblem[]; context: TemplateFormContext;
  entityOptions: SectionProps["options"]["entityOptions"]; focusName: boolean; onFocused: () => void; onSelectItem: (key: string | null) => void;
}) {
  const { doc, update } = draft;
  const kind = trait.kind;
  const template = templateOf(kind);
  const primary = PRIMARY_KEYS[kind];
  const moreKeys = MORE_KEYS[kind];
  const errorAt = (suffix: string) => problemMessage(problemsByField(problems, `/traits/${index}${suffix}`));
  const prefix = `/traits/${index}/spec`;
  const [moreOpen, setMoreOpen] = useState<boolean | undefined>(undefined);
  const moreProblem = [...moreKeys, "bindings"].some((k) => problemsByField(problems, `${prefix}/${k}`).length > 0);
  const open = moreOpen ?? moreProblem;
  const moreCount = setFieldCount(template, moreKeys, trait.spec) + (bindingCount(trait.spec.bindings) > 0 ? 1 : 0);

  useEffect(() => {
    if (!focusName) return;
    document.getElementById(kind === "MESSAGE" ? "trait-name" : "trait-title")?.focus();
    onFocused();
    // Focus once, when the freshly added set is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patch(change: (t: LocalTrait) => LocalTrait) {
    update((d) => ({ ...d, traits: d.traits.map((t, i) => (i === index && !isLibraryTrait(t) ? change(t) : t)) }));
  }

  /** Once the user leaves the form: a placeholder key becomes a name from the set's name or title. Later edits never rename it again. */
  function nameKeyFromContent() {
    const result = autoNameTrait(doc, trait.key);
    if (result.key === trait.key) return;
    update((d) => autoNameTrait(d, trait.key).doc);
    onSelectItem(result.key);
  }

  function renameActive(to: string) {
    const from = trait.key;
    if (!renameKey(doc, "trait", from, to).success) return;
    update((d) => {
      const renamed = renameKey(d, "trait", from, to);
      return renamed.success ? renamed.data : d;
    });
    onSelectItem(to);
  }

  /** A template form for some fields of the set: it sees only those keys and its edits are merged into `spec`. */
  const specForm = (keys: string[]) => (
    <TemplateForm
      template={cardTemplate(template, keys)} value={pickValue(trait.spec, keys)} idPrefix="trait" errors={problems} errorPrefix={prefix}
      context={context} compactHelp
      onChange={(next) => patch((t) => {
        let spec = t.spec;
        for (const k of keys) spec = setField(spec, k, next[k]) as JsonObject;
        return { ...t, spec };
      })}
    />
  );

  const pin = trait.headers;
  const pinName = pin ? entityOptions.find((e) => e.id === pin.entityId)?.name ?? pin.entityId : null;
  const headersError = errorAt("/spec/headers");
  const label = traitLabel(trait, []);

  return (
    <div className="max-w-2xl space-y-space-4" data-testid="trait-form">
      <div className="flex flex-wrap items-center justify-between gap-space-2">
        <Badge variant="outline" data-testid="trait-kind">{propertiesTitle(kind)}</Badge>
        <UsageLine doc={doc} trait={trait} />
      </div>
      <div onBlur={(e) => { if (leftForm(e)) nameKeyFromContent(); }} className="space-y-space-4">
        {specForm(primary)}
        {kind === "MESSAGE" && (
          <section aria-labelledby="trait-properties-heading" className="space-y-space-2">
            <h3 id="trait-properties-heading" className="text-body font-medium text-foreground">Properties</h3>
            <PropertiesTable
              idPrefix="trait-props" headers={trait.spec.headers}
              onChange={(headers) => patch((t) => ({ ...t, spec: headers === undefined ? omit(t.spec, "headers") : { ...t.spec, headers } }))}
            />
            {headersError && <p data-testid="trait-props-error" className="text-body-small text-destructive">{headersError}</p>}
            {pinName && (
              <p data-testid="trait-headers-note" className="text-caption text-muted-foreground">Headers also come from the entity {pinName}.</p>
            )}
          </section>
        )}

        <section className="rounded-lg border border-border">
          <h3 className="text-body font-medium text-foreground">
            <button
              type="button" data-testid="trait-more-toggle" aria-expanded={open} aria-controls="trait-more" onClick={() => setMoreOpen(!open)}
              className="flex w-full items-center gap-space-2 rounded-lg px-space-4 py-space-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {open ? <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
              <span>More details</span>
              <Badge variant="secondary" data-testid="trait-more-count">{moreCount}</Badge>
            </button>
          </h3>
          {open && (
            <div id="trait-more" data-testid="trait-more" role="region" aria-label="More details" className="space-y-space-4 border-t border-border p-space-4">
              {specForm(moreKeys)}
              <BindingsForm
                target={kind === "MESSAGE" ? "message" : "operation"} value={(trait.spec.bindings ?? {}) as Record<string, unknown>}
                idPrefix="trait-bindings" errors={problems} errorPrefix={`${prefix}/bindings`}
                onChange={(next) => patch((t) => ({ ...t, spec: isEmptyValue(next) ? omit(t.spec, "bindings") : { ...t.spec, bindings: next as JsonObject } }))}
              />
              {Object.keys(trait.spec).some((k) => ![...primary, ...moreKeys, "bindings", "headers"].includes(k)) && (
                <p data-testid="trait-other" className="text-caption text-muted-foreground">
                  {`Other properties (kept as they are): ${Object.keys(trait.spec).filter((k) => ![...primary, ...moreKeys, "bindings", "headers"].includes(k)).join(", ")}`}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
      <IdentifierDisclosure
        id="trait-key" value={trait.key} error={errorAt("/key")}
        taken={doc.traits.filter((_, i) => i !== index).map((t) => t.key)} onRename={renameActive}
      />
      <RemoveButton kind={kind} onClick={() => removeWithConfirm(draft, index, label, onSelectItem)} />
    </div>
  );
}

function LibraryItem({ draft, index, trait, library, problems, onSelectItem }: {
  draft: DraftState; index: number; trait: LibraryTrait; library: LibraryTraitOption[]; problems: DocumentProblem[];
  onSelectItem: (key: string | null) => void;
}) {
  const { doc } = draft;
  const found = optionOf(trait, library);
  const errorAt = (suffix: string) => problemMessage(problemsByField(problems, `/traits/${index}${suffix}`));
  const keyError = errorAt("/key");
  const idError = errorAt("/libraryTraitId");
  const label = traitLabel(trait, library);
  const builtIn = found?.bundled === true;
  return (
    <div className="max-w-2xl space-y-space-4" data-testid="trait-library-form">
      <div className="flex flex-wrap items-center justify-between gap-space-2">
        <div className="flex flex-wrap items-center gap-space-2">
          <h3 data-testid="trait-library-name" className="text-heading-3 text-foreground">{label}</h3>
          <Badge variant="outline">{TRAIT_BADGE}</Badge>
          <Badge variant="secondary" className="gap-1"><Lock aria-hidden="true" />{builtIn ? BUILT_IN_BADGE : LIBRARY_BADGE}</Badge>
          <Badge variant="outline" data-testid="trait-kind">{propertiesTitle(trait.kind)}</Badge>
        </div>
        <UsageLine doc={doc} trait={trait} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-space-4 gap-y-space-1 text-body-small">
        <dt className="text-muted-foreground">Applies to</dt>
        <dd data-testid="trait-library-kind" className="text-foreground">{trait.kind === "MESSAGE" ? "Messages" : "Operations"}</dd>
        <dt className="text-muted-foreground">Level</dt>
        <dd data-testid="trait-library-level" className="text-foreground">{found?.level ?? "Unknown"}</dd>
      </dl>
      <p data-testid="trait-library-note" className="rounded-md border border-border bg-muted/30 px-space-3 py-space-2 text-body-small text-muted-foreground">
        {builtIn ? `${BUILT_IN_NOTE}. ${builtInExplanation(label)}` : LIBRARY_NOTE}
      </p>
      {found && trait.kind === "MESSAGE" && (
        <PropertiesTable
          idPrefix="trait-props" headers={traitHeaders(trait, library)} summary={found.properties} readOnly note={builtIn ? BUILT_IN_NOTE : LIBRARY_NOTE}
        />
      )}
      {found && trait.kind === "OPERATION" && <LockedNote id="trait-props-note">{LIBRARY_NOTE}</LockedNote>}
      {!found && (
        <p data-testid="trait-library-missing" className="text-body-small text-warning">
          This library set is not offered to this event any more (it may have been deleted, or it belongs to a product or another domain).
        </p>
      )}
      {idError && <p data-testid="trait-library-error" className="text-body-small text-destructive">{idError}</p>}
      {keyError && (
        <IdentifierDisclosure
          id="trait-key" value={trait.key} error={keyError}
          taken={doc.traits.filter((_, i) => i !== index).map((t) => t.key)}
          onRename={(to) => {
            const from = trait.key;
            if (!renameKey(doc, "trait", from, to).success) return;
            draft.update((d) => {
              const renamed = renameKey(d, "trait", from, to);
              return renamed.success ? renamed.data : d;
            });
            onSelectItem(to);
          }}
        />
      )}
      <RemoveButton kind={trait.kind} library onClick={() => removeWithConfirm(draft, index, label, onSelectItem)} />
    </div>
  );
}
