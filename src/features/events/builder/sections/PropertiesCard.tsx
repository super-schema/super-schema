"use client";

// src/features/events/builder/sections/PropertiesCard.tsx
// The "Message properties (Trait)" / "Operation properties (Trait)" card of a message or an operation form: the properties are visible
// where they are used. One row per applied set (name, "Trait" badge, a lock when it is built in or from the library), a "+ Add" that opens the
// same chooser filtered to this kind and applies the choice to THIS message / operation in one step (creating the document entry when it
// needs one), a × per row that takes the set off this item (a library entry nothing uses any more goes with it), and every row expands:
//   - message set, built in or library  -> the read-only Properties table with a lock note
//   - message set, local                 -> the editable Properties table, its name, and a link to every other detail
//   - operation set                      -> its metadata (title, summary, description, tags, docs): read-only from the library, editable if local
// Test ids (`p` = message | operation): `${p}-props`, `${p}-prop-add` (the chooser trigger), `${p}-prop-empty`, `${p}-prop-error`,
// `${p}-prop-row-<key>`, `-toggle-<key>`, `-lock-<key>`, `-count-<key>`, `-remove-<key>`, `-panel-<key>`; the table inside is `${p}-prop-<key>-…`.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Lock, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { JsonObject, TraitKind } from "@/lib/event-specs/types";
import { isLibraryTrait, type DocTrait, type DocumentProblem } from "@/lib/events/document/types";
import { TEMPLATES } from "@/lib/events/templates";
import { leftForm } from "../auto-key";
import type { BuilderOptions } from "../EventBuilder";
import {
  addPropertiesLabel, BUILT_IN_BADGE, BUILT_IN_NOTE, LIBRARY_BADGE, LIBRARY_NOTE, propertiesNameLower, propertyCountText, TRAIT_BADGE,
} from "../labels";
import { problemMessage, problemsByField } from "../problems";
import { TemplateForm } from "../template";
import { setField } from "../template/value";
import {
  addChoice, applyTrait, autoNameTrait, isBuiltInEntry, optionOf, traitHeaders, traitLabel, traitPropertyCount, unapplyTrait, type TraitChoice, type TraitTarget,
} from "../traits";
import type { BuilderSection } from "../sections";
import type { DraftState } from "../use-event-draft";
import { cardTemplate, pickValue } from "./form-cards";
import { PropertiesChooser } from "./PropertiesChooser";
import { LockedNote, PropertiesTable } from "./PropertiesTable";

export interface PropertiesCardProps {
  kind: TraitKind;
  draft: DraftState;
  options: BuilderOptions;
  /** The message or operation the card belongs to. */
  target: TraitTarget;
  /** Its `traitKeys`. */
  traitKeys: string[];
  problems: DocumentProblem[];
  /** Pointer of the item's `traitKeys` (`/messages/0/traitKeys`), where the parser reports a bad reference. */
  errorPointer: string;
  /** Lets the card send the user to the full form of a local set (absent when the host cannot switch sections). */
  onSectionChange?: (section: BuilderSection) => void;
  onSelectItem?: (key: string | null) => void;
}

type LocalTrait = Extract<DocTrait, { spec: JsonObject }>;

const META_KEYS = ["title", "summary", "description"] as const;

/** The first line of a library set's metadata, as a definition list (read-only). */
function MetadataList({ id, spec }: { id: string; spec: JsonObject }) {
  const text = (key: string) => (typeof spec[key] === "string" && spec[key] !== "" ? (spec[key] as string) : null);
  const tags = Array.isArray(spec.tags) ? spec.tags.flatMap((t) => (typeof t === "object" && t !== null && !Array.isArray(t) && typeof t.name === "string" ? [t.name] : [])) : [];
  const docs = typeof spec.externalDocs === "object" && spec.externalDocs !== null && !Array.isArray(spec.externalDocs) && typeof spec.externalDocs.url === "string" ? spec.externalDocs.url : null;
  const rows: Array<[string, string, string | null]> = [
    ["title", "Title", text("title")], ["summary", "Summary", text("summary")], ["description", "Description", text("description")],
    ["tags", "Tags", tags.length > 0 ? tags.join(", ") : null], ["docs", "Docs", docs],
  ];
  const shown = rows.filter((r) => r[2] !== null);
  if (shown.length === 0) return <p data-testid={`${id}-meta-empty`} className="text-body-small text-muted-foreground">No details are set.</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-space-4 gap-y-space-1 text-body-small">
      {shown.map(([key, label, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd data-testid={`${id}-meta-${key}`} className="text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The expanded body of a LOCAL set: its name (or title), and for a message set the editable Properties table. */
function LocalPanel({ draft, options, kind, trait, idPrefix, focusName, onFocused, onRenamed, onSectionChange, onSelectItem }: {
  draft: DraftState; options: BuilderOptions; kind: TraitKind; trait: LocalTrait; idPrefix: string; focusName: boolean;
  onFocused: () => void; onRenamed: (from: string, to: string) => void;
  onSectionChange?: (section: BuilderSection) => void; onSelectItem?: (key: string | null) => void;
}) {
  const { update } = draft;
  const template = kind === "MESSAGE" ? TEMPLATES.messageTrait : TEMPLATES.operationTrait;
  const keys = kind === "MESSAGE" ? ["name"] : META_KEYS;
  const form = cardTemplate(template, keys);
  const key = trait.key;

  useEffect(() => {
    if (!focusName) return;
    document.getElementById(`${idPrefix}-${kind === "MESSAGE" ? "name" : "title"}`)?.focus();
    onFocused();
    // Focus once, when the freshly added set is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patchSpec(change: (spec: JsonObject) => JsonObject) {
    update((d) => ({ ...d, traits: d.traits.map((t) => (t.key === key && !isLibraryTrait(t) ? { ...t, spec: change(t.spec) } : t)) }));
  }

  function nameFromContent() {
    const result = autoNameTrait(draft.doc, key);
    if (result.key === key) return;
    update((d) => autoNameTrait(d, key).doc);
    onRenamed(key, result.key);
  }

  const pin = trait.headers;
  const pinName = pin ? options.entityOptions.find((e) => e.id === pin.entityId)?.name ?? pin.entityId : null;

  return (
    <div className="space-y-space-3" onBlur={(e) => { if (leftForm(e)) nameFromContent(); }}>
      <TemplateForm
        template={form} value={pickValue(trait.spec, keys)} idPrefix={idPrefix} compactHelp
        onChange={(next) => patchSpec((spec) => {
          let out = spec;
          for (const k of keys) out = setField(out, k, next[k]) as JsonObject;
          return out;
        })}
      />
      {kind === "MESSAGE" && (
        <PropertiesTable
          idPrefix={idPrefix} headers={trait.spec.headers}
          onChange={(headers) => patchSpec((spec) => (headers === undefined ? omit(spec, "headers") : { ...spec, headers }))}
        />
      )}
      {pinName && <p data-testid={`${idPrefix}-pin-note`} className="text-caption text-muted-foreground">Headers come from the entity {pinName}.</p>}
      {onSectionChange && onSelectItem && (
        <Button
          type="button" size="sm" variant="ghost" data-testid={`${idPrefix}-more`}
          onClick={() => { onSectionChange("traits"); onSelectItem(key); }}
        >
          Edit all details
        </Button>
      )}
    </div>
  );
}

const omit = (spec: JsonObject, key: string): JsonObject => {
  const next = { ...spec };
  delete next[key];
  return next;
};

export function PropertiesCard({ kind, draft, options, target, traitKeys, problems, errorPointer, onSectionChange, onSelectItem }: PropertiesCardProps) {
  const { doc, update } = draft;
  const library = options.libraryTraits;
  const p = target.kind;
  const [expanded, setExpanded] = useState<string[]>([]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const error = problemMessage(problemsByField(problems, errorPointer));

  const applied = traitKeys.map((key) => ({ key, trait: doc.traits.find((t) => t.key === key) }));
  const appliedLibraryIds = applied.flatMap((a) => (a.trait && isLibraryTrait(a.trait) ? [a.trait.libraryTraitId] : []));
  const usedLibraryIds = doc.traits.flatMap((t) => (isLibraryTrait(t) ? [t.libraryTraitId] : []));

  function choose(choice: TraitChoice) {
    const { key } = addChoice(doc, choice);
    update((d) => {
      const added = addChoice(d, choice);
      return applyTrait(added.doc, target, added.key);
    });
    setExpanded((e) => (e.includes(key) ? e : [...e, key]));
    if (choice.type === "blank") setFocusKey(key);
  }

  function toggle(key: string) {
    setExpanded((e) => (e.includes(key) ? e.filter((k) => k !== key) : [...e, key]));
  }

  function remove(key: string) {
    update((d) => unapplyTrait(d, target, key));
    setExpanded((e) => e.filter((k) => k !== key));
  }

  function renamed(from: string, to: string) {
    setExpanded((e) => e.map((k) => (k === from ? to : k)));
  }

  const itemWord = p === "message" ? "message" : "operation";

  return (
    <div data-testid={`${p}-props`} className="space-y-space-3">
      <div className="flex items-start justify-between gap-space-3">
        <p className="text-caption text-muted-foreground">
          {kind === "MESSAGE"
            ? "Properties every copy of this message carries, such as the CloudEvents attributes. Built-in and library sets are read-only here."
            : "Metadata shared by operations, applied to this operation."}
        </p>
        <PropertiesChooser
          library={library} kind={kind} disabledIds={appliedLibraryIds} usedIds={usedLibraryIds} onChoose={choose}
          triggerTestId={`${p}-prop-add`} triggerLabel={addPropertiesLabel(kind)} triggerVariant="outline"
        />
      </div>

      {applied.length === 0 ? (
        <p data-testid={`${p}-prop-empty`} className="rounded-md border border-dashed border-border px-space-3 py-space-3 text-body-small text-muted-foreground">
          {`No ${propertiesNameLower(kind)} on this ${itemWord} yet. Use Add to apply one.`}
        </p>
      ) : (
        <ul aria-label={`Applied ${propertiesNameLower(kind)}`} className="space-y-space-2">
          {applied.map(({ key, trait }) => {
            if (!trait) {
              return (
                <li key={key} data-testid={`${p}-prop-row-${key}`} className="flex items-center justify-between gap-space-2 rounded-md border border-border px-space-3 py-space-2">
                  <span className="text-body-small text-warning">{`${key} (not defined)`}</span>
                  <RemoveButton id={`${p}-prop-remove-${key}`} label={`Remove ${key} from this ${itemWord}`} onClick={() => remove(key)} />
                </li>
              );
            }
            const open = expanded.includes(key);
            const label = traitLabel(trait, library);
            const builtIn = isBuiltInEntry(trait, library);
            const fromLibrary = isLibraryTrait(trait);
            const count = traitPropertyCount(trait, library);
            const idPrefix = `${p}-prop-${key}`;
            const option = optionOf(trait, library);
            const panelId = `${p}-prop-panel-${key}`;
            return (
              <li key={key} data-testid={`${p}-prop-row-${key}`} className="rounded-md border border-border">
                <div className="flex items-center gap-space-2 pr-space-2">
                  <button
                    type="button" data-testid={`${p}-prop-toggle-${key}`} aria-expanded={open} aria-controls={panelId} onClick={() => toggle(key)}
                    className="flex min-w-0 flex-1 items-center gap-space-2 rounded-md px-space-3 py-space-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {open ? <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate text-body-small font-medium text-foreground">{label}</span>
                    <Badge variant="outline" data-testid={`${p}-prop-badge-${key}`}>{TRAIT_BADGE}</Badge>
                    {fromLibrary && (
                      <span data-testid={`${p}-prop-lock-${key}`} title={builtIn ? BUILT_IN_NOTE : LIBRARY_NOTE} className="inline-flex items-center gap-1 text-caption text-muted-foreground">
                        <Lock aria-hidden="true" className="size-3.5" />
                        <span>{builtIn ? BUILT_IN_BADGE : LIBRARY_BADGE}</span>
                      </span>
                    )}
                    {count !== null && count > 0 && (
                      <span data-testid={`${p}-prop-count-${key}`} className="text-caption text-muted-foreground">{propertyCountText(count)}</span>
                    )}
                  </button>
                  <RemoveButton id={`${p}-prop-remove-${key}`} label={`Remove ${label} from this ${itemWord}`} onClick={() => remove(key)} />
                </div>
                {open && (
                  <div id={panelId} data-testid={panelId} role="region" aria-label={`${label} properties`} className="space-y-space-3 border-t border-border p-space-3">
                    {!isLibraryTrait(trait) ? (
                      <LocalPanel
                        draft={draft} options={options} kind={kind} trait={trait} idPrefix={idPrefix} focusName={focusKey === key}
                        onFocused={() => setFocusKey(null)} onRenamed={renamed} onSectionChange={onSectionChange} onSelectItem={onSelectItem}
                      />
                    ) : !option ? (
                      <p data-testid={`${idPrefix}-missing`} className="text-body-small text-warning">
                        This set is not offered to this event any more (it may have been deleted, or it belongs to another domain). Take it off, or choose another.
                      </p>
                    ) : kind === "MESSAGE" ? (
                      <>
                        <p data-testid={`${idPrefix}-defined-by`} className="text-body-small text-muted-foreground">
                          Defined by <span className="font-medium text-foreground">{option.name}</span>{option.level ? ` · ${option.level}` : ""}
                        </p>
                        <PropertiesTable
                          idPrefix={idPrefix} headers={traitHeaders(trait, library)} summary={option.properties} readOnly note={option.bundled ? BUILT_IN_NOTE : LIBRARY_NOTE}
                        />
                      </>
                    ) : (
                      <>
                        <LockedNote id={`${idPrefix}-note`}>{LIBRARY_NOTE}</LockedNote>
                        {option.spec ? <MetadataList id={idPrefix} spec={option.spec} /> : (
                          <p data-testid={`${idPrefix}-meta-empty`} className="text-body-small text-muted-foreground">Defined in the library at {option.level ?? "the Tenant or Domain level"}.</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p data-testid={`${p}-prop-error`} className="text-body-small text-destructive">{error}</p>}
    </div>
  );
}

function RemoveButton({ id, label, onClick }: { id: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button" aria-label={label} data-testid={id} onClick={onClick}
      className="shrink-0 rounded-md p-1 text-muted-foreground outline-none hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <X aria-hidden="true" className="size-4" />
    </button>
  );
}
