"use client";

// src/features/events/builder/sections/TraitsSection.tsx
// Traits: reusable message and operation traits. A trait is either LOCAL (the AsyncAPI trait object as a template form, bound to
// `trait.spec`, plus an optional headers entity and protocol bindings) or from the Tenant / Domain LIBRARY (read-only here: it is
// edited where it is defined). Messages and operations pick traits by key (`traitKeys`); this section owns the traits themselves.
// The key is generated from the name or title once the user leaves the form; the "Identifier" below the form is the only place it
// shows. Removing a trait that is used asks first and takes it off every message and operation that carries it.
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { JsonObject, TraitKind } from "@/lib/event-specs/types";
import { renameKey } from "@/lib/events/document/keys";
import { isLibraryTrait, type DocTrait, type DocumentProblem, type EventDocument } from "@/lib/events/document/types";
import type { EntityPin } from "@/lib/events/types";
import { TEMPLATES } from "@/lib/events/templates";
import { autoRenameKey, leftForm, newKey } from "../auto-key";
import type { LibraryTraitOption, SectionProps } from "../EventBuilder";
import { IdentifierDisclosure } from "../Identifier";
import { problemMessage, problemsByField, uniqueProblems } from "../problems";
import { buildReferenceContext } from "../references";
import { BindingsForm, TemplateForm, type TemplateFormContext } from "../template";
import { FieldControl } from "../template/FieldControl";
import { setField } from "../template/value";
import { libraryTraitKey, removeTrait, traitUsage, usageText } from "../traits";
import type { DraftState } from "../use-event-draft";

type LocalTrait = Extract<DocTrait, { spec: JsonObject }>;
type LibraryTrait = Extract<DocTrait, { libraryTraitId: string }>;

const KIND_LABELS: Record<TraitKind, { one: string; many: string }> = {
  MESSAGE: { one: "Message trait", many: "Message traits" },
  OPERATION: { one: "Operation trait", many: "Operation traits" },
};
const KINDS: TraitKind[] = ["MESSAGE", "OPERATION"];
const NO_LIBRARY: LibraryTraitOption[] = [];

/** Template fields drawn by hand, so the form skips them: the headers entity (it is `trait.headers`, not `spec.headers`) and the bindings. */
const HIDDEN: Record<TraitKind, string[]> = { MESSAGE: ["headers", "bindings"], OPERATION: ["bindings"] };
const HEADERS_FIELD = TEMPLATES.messageTrait.fields.find((f) => f.key === "headers")!;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a trait is called in the list: its name or title, else the key once it has a real one, else "New message trait". */
function traitLabel(trait: DocTrait, library: LibraryTraitOption[]): string {
  if (isLibraryTrait(trait)) return library.find((l) => l.id === trait.libraryTraitId)?.name ?? trait.key;
  const spec = trait.spec;
  const named = [spec.name, spec.title].find((v): v is string => typeof v === "string" && v.trim() !== "");
  if (named) return named.trim();
  return /^trait(-\d+)?$/.test(trait.key) ? `New ${KIND_LABELS[trait.kind].one.toLowerCase()}` : trait.key;
}

export function TraitsSection({ draft, options, selectedItem, onSelectItem }: SectionProps) {
  const { doc, update } = draft;
  const traits = doc.traits;
  const library = options.libraryTraits ?? NO_LIBRARY;
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = uniqueProblems(draft.problems.concat(draft.serverProblems));
  const context = useMemo(() => buildReferenceContext(doc, { entityOptions: options.entityOptions }), [doc, options.entityOptions]);
  const [choice, setChoice] = useState("");

  // List order is by group (message traits, then operation traits); the form follows the selected key, else the first row.
  const entries = traits.map((trait, index) => ({ trait, index }));
  const grouped = KINDS.map((kind) => ({ kind, entries: entries.filter((e) => e.trait.kind === kind) }));
  const ordered = grouped.flatMap((g) => g.entries);
  const active = (selectedItem === null ? undefined : ordered.find((e) => e.trait.key === selectedItem)) ?? ordered[0] ?? null;

  const used = new Set(traits.flatMap((t) => (isLibraryTrait(t) ? [t.libraryTraitId] : [])));
  const available = library.filter((l) => !used.has(l.id));
  const picked = available.find((l) => l.id === choice);

  function addLocal(kind: TraitKind) {
    const key = newKey(doc, "trait");
    update((d) => ({ ...d, traits: [...d.traits, { key, kind, spec: {} }] }));
    onSelectItem(key);
  }

  function addFromLibrary() {
    if (!picked) return;
    const key = libraryTraitKey(doc, picked.name);
    update((d) => ({ ...d, traits: [...d.traits, { key, kind: picked.kind, libraryTraitId: picked.id }] }));
    setChoice("");
    onSelectItem(key);
  }

  const libraryHint = library.length === 0
    ? "There are no library traits yet. Define them under Traits at the Tenant or Domain level."
    : "Every library trait is already used by this event.";

  return (
    <section aria-labelledby="traits-heading" data-testid="section-traits" className="space-y-space-6">
      <header className="space-y-space-1">
        <h2 id="traits-heading" className="text-heading-3 text-foreground">Traits</h2>
        <p className="text-body-small text-muted-foreground">
          Reusable pieces that messages and operations pick up: write one here, or use one from the Tenant or Domain library.
        </p>
      </header>

      <div data-testid="trait-actions" className="flex flex-wrap items-end gap-space-3">
        <Button type="button" size="sm" variant="outline" onClick={() => addLocal("MESSAGE")} data-testid="trait-add-message" className="gap-1.5">
          <Plus className="size-4" /> Add message trait
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => addLocal("OPERATION")} data-testid="trait-add-operation" className="gap-1.5">
          <Plus className="size-4" /> Add operation trait
        </Button>
        <div className="flex flex-wrap items-center gap-space-2">
          <select
            aria-label="Library trait" data-testid="trait-library-select" value={picked ? picked.id : ""} disabled={available.length === 0}
            aria-describedby={available.length === 0 ? "trait-library-empty" : undefined}
            onChange={(e) => setChoice(e.target.value)}
            className="max-w-64 rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small"
          >
            <option value="">{available.length === 0 ? "No library traits available" : "Choose a library trait…"}</option>
            {KINDS.map((kind) => {
              const ofKind = available.filter((l) => l.kind === kind);
              if (ofKind.length === 0) return null;
              return (
                <optgroup key={kind} label={KIND_LABELS[kind].many} data-testid={`trait-library-group-${kind.toLowerCase()}`}>
                  {ofKind.map((l) => <option key={l.id} value={l.id}>{l.level ? `${l.name} · ${l.level}` : l.name}</option>)}
                </optgroup>
              );
            })}
          </select>
          <Button type="button" size="sm" variant="outline" onClick={addFromLibrary} disabled={!picked} data-testid="trait-add-library" className="gap-1.5">
            <Plus className="size-4" /> Add from library
          </Button>
        </div>
        {available.length === 0 && (
          <p id="trait-library-empty" data-testid="trait-library-empty" className="basis-full text-caption text-muted-foreground">{libraryHint}</p>
        )}
      </div>

      {!active ? (
        <div data-testid="trait-empty" className="space-y-space-1 rounded-lg border border-dashed border-border p-space-6 text-center">
          <p className="text-heading-3 text-foreground">No traits yet</p>
          <p className="text-body-small text-muted-foreground">Traits are optional. Add a message trait or an operation trait above, or pick one from the library.</p>
        </div>
      ) : (
        <div className="grid gap-space-6 md:grid-cols-[14rem_1fr]">
          <div className="space-y-space-4">
            {grouped.map(({ kind, entries: rows }) => {
              const lower = kind.toLowerCase();
              return (
                <div key={kind} data-testid={`trait-group-${lower}`} className="space-y-space-1">
                  <h3 className="px-space-3 text-caption font-medium text-muted-foreground">{KIND_LABELS[kind].many}</h3>
                  {rows.length === 0 ? (
                    <p data-testid={`trait-group-${lower}-empty`} className="px-space-3 text-caption text-muted-foreground">None yet.</p>
                  ) : (
                    <ul aria-label={KIND_LABELS[kind].many} className="space-y-space-1">
                      {rows.map(({ trait, index }) => {
                        const isActive = index === active.index;
                        const broken = problemsByField(problems, `/traits/${index}`).length > 0;
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
                                <span className="block truncate text-caption text-muted-foreground">{usageText(trait.kind, traitUsage(doc, trait.key))}</span>
                              </span>
                              <span className="flex shrink-0 items-center gap-space-1">
                                {isLibraryTrait(trait) && <Badge variant="secondary" data-testid={`trait-row-${trait.key}-library`}>library</Badge>}
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
            <LibraryTraitItem
              key={active.index} draft={draft} index={active.index} trait={active.trait} library={library}
              problems={problems} onSelectItem={onSelectItem}
            />
          ) : (
            <LocalTraitForm
              key={active.index} draft={draft} index={active.index} trait={active.trait} problems={problems}
              context={context} onSelectItem={onSelectItem}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** "Used by 2 messages" for the trait at `index`, with the keys of the users listed for the tooltip. */
function UsageLine({ doc, trait }: { doc: EventDocument; trait: DocTrait }) {
  const usage = traitUsage(doc, trait.key);
  const users = [...usage.messages, ...usage.operations];
  return (
    <p data-testid="trait-usage" title={users.length > 0 ? users.join(", ") : undefined} className="text-body-small text-muted-foreground">
      {usageText(trait.kind, usage)}
    </p>
  );
}

/** Remove the trait at `index`. A trait in use asks first, then leaves the messages and operations that carried it. */
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
    if (!window.confirm(`Trait "${label}" is used by ${where}. Remove it and take it off ${count === 1 ? "that item" : "those items"}?`)) return;
  }
  draft.update((d) => removeTrait(d, index));
  onSelectItem(null);
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex justify-end">
      <Button type="button" variant="outline" onClick={onClick} data-testid="trait-remove" className="gap-1.5 text-muted-foreground hover:text-destructive">
        <Trash2 className="size-4" /> Remove trait
      </Button>
    </div>
  );
}

function LocalTraitForm({ draft, index, trait, problems, context, onSelectItem }: {
  draft: DraftState; index: number; trait: LocalTrait; problems: DocumentProblem[]; context: TemplateFormContext;
  onSelectItem: (key: string | null) => void;
}) {
  const { doc, update } = draft;
  const kind = trait.kind;
  const template = kind === "MESSAGE" ? TEMPLATES.messageTrait : TEMPLATES.operationTrait;
  const errorAt = (suffix: string) => problemMessage(problemsByField(problems, `/traits/${index}${suffix}`));

  function patch(change: (t: LocalTrait) => LocalTrait) {
    update((d) => ({ ...d, traits: d.traits.map((t, i) => (i === index && !isLibraryTrait(t) ? change(t) : t)) }));
  }

  /** Once the user leaves the form: a placeholder key becomes a name from the trait's name or title. Later edits never rename it again. */
  function nameKeyFromContent() {
    const from = trait.key;
    const values = (d: EventDocument) => {
      const found = d.traits.find((t) => t.key === from);
      const spec = found && !isLibraryTrait(found) ? found.spec : {};
      return { name: spec.name, title: spec.title };
    };
    const preview = autoRenameKey(doc, "trait", from, values(doc));
    if (preview === doc) return;
    update((d) => autoRenameKey(d, "trait", from, values(d)));
    onSelectItem(preview.traits[index].key);
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

  function setHeaders(next: unknown) {
    patch((t) => {
      const copy = { ...t };
      if (next) copy.headers = next as EntityPin;
      else delete copy.headers;
      return copy;
    });
  }

  const label = traitLabel(trait, []);
  return (
    <div className="max-w-2xl space-y-space-4" data-testid="trait-form">
      <div className="flex flex-wrap items-center justify-between gap-space-2">
        <Badge variant="outline" data-testid="trait-kind">{KIND_LABELS[kind].one}</Badge>
        <UsageLine doc={doc} trait={trait} />
      </div>
      <div onBlur={(e) => { if (leftForm(e)) nameKeyFromContent(); }} className="space-y-space-4">
        <TemplateForm
          template={template} value={trait.spec} idPrefix="trait" errors={problems} errorPrefix={`/traits/${index}/spec`}
          context={context} hideKeys={HIDDEN[kind]}
          onChange={(next) => patch((t) => ({ ...t, spec: next as JsonObject }))}
        />
        {kind === "MESSAGE" && (
          <FieldControl
            field={HEADERS_FIELD} value={trait.headers} idPrefix="trait" errorPrefix={`/traits/${index}`}
            env={{ context, errors: problems }} onChange={setHeaders}
          />
        )}
        <BindingsForm
          target={kind === "MESSAGE" ? "message" : "operation"} value={(trait.spec.bindings ?? {}) as Record<string, unknown>}
          idPrefix="trait-bindings" errors={problems} errorPrefix={`/traits/${index}/spec/bindings`}
          onChange={(next) => patch((t) => ({ ...t, spec: setField(t.spec, "bindings", next) as JsonObject }))}
        />
      </div>
      <IdentifierDisclosure
        id="trait-key" value={trait.key} error={errorAt("/key")}
        taken={doc.traits.filter((_, i) => i !== index).map((t) => t.key)} onRename={renameActive}
      />
      <RemoveButton onClick={() => removeWithConfirm(draft, index, label, onSelectItem)} />
    </div>
  );
}

function LibraryTraitItem({ draft, index, trait, library, problems, onSelectItem }: {
  draft: DraftState; index: number; trait: LibraryTrait; library: LibraryTraitOption[]; problems: DocumentProblem[];
  onSelectItem: (key: string | null) => void;
}) {
  const { doc } = draft;
  const found = library.find((l) => l.id === trait.libraryTraitId);
  const errorAt = (suffix: string) => problemMessage(problemsByField(problems, `/traits/${index}${suffix}`));
  const keyError = errorAt("/key");
  const idError = errorAt("/libraryTraitId");
  const label = traitLabel(trait, library);
  return (
    <div className="max-w-2xl space-y-space-4" data-testid="trait-library-form">
      <div className="flex flex-wrap items-center justify-between gap-space-2">
        <div className="flex flex-wrap items-center gap-space-2">
          <h3 data-testid="trait-library-name" className="text-heading-3 text-foreground">{label}</h3>
          <Badge variant="secondary">library</Badge>
          <Badge variant="outline" data-testid="trait-kind">{KIND_LABELS[trait.kind].one}</Badge>
        </div>
        <UsageLine doc={doc} trait={trait} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-space-4 gap-y-space-1 text-body-small">
        <dt className="text-muted-foreground">Kind</dt>
        <dd data-testid="trait-library-kind" className="text-foreground">{KIND_LABELS[trait.kind].one}</dd>
        <dt className="text-muted-foreground">Level</dt>
        <dd data-testid="trait-library-level" className="text-foreground">{found?.level ?? "Unknown"}</dd>
      </dl>
      <p data-testid="trait-library-note" className="rounded-md border border-border bg-muted/30 px-space-3 py-space-2 text-body-small text-muted-foreground">
        Defined in the library — edit it under Traits at the Tenant or Domain level.
      </p>
      {!found && (
        <p data-testid="trait-library-missing" className="text-body-small text-warning">
          This library trait is not offered to this event any more (it may have been deleted, or it belongs to a product or another domain).
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
      <RemoveButton onClick={() => removeWithConfirm(draft, index, label, onSelectItem)} />
    </div>
  );
}
