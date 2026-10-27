"use client";

// src/features/events/builder/sections/AdvancedSection.tsx
// Advanced: the document's `components`. Today that is the security schemes servers, operations and operation traits point at. A
// scheme's NAME is the key those references use, so it is a visible, required field (not a tucked-away identifier): renaming it
// rewrites every reference, and it can never duplicate another scheme's name. Everything else about a scheme is the AsyncAPI
// security scheme template: the type first, then the properties that type needs.
import { useMemo, useState, type KeyboardEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { type DocSecurityScheme, type DocumentProblem } from "@/lib/events/document/types";
import { TEMPLATES } from "@/lib/events/templates";
import type { SectionProps } from "../EventBuilder";
import { problemMessage, problemsByField, uniqueProblems } from "../problems";
import { buildReferenceContext } from "../references";
import {
  addSecurityScheme, newSchemeName, removeSecurityScheme, renameSecurityScheme, schemeNameProblem, schemeReferences, schemesOf,
  updateSecurityScheme, type SchemeReferences,
} from "../security-schemes";
import { TemplateForm } from "../template";
import type { DraftState } from "../use-event-draft";

const DEFAULT_TYPE: DocSecurityScheme["type"] = "userPassword";
const TYPE_LABELS: Map<string, string> = new Map(
  (TEMPLATES.securityScheme.fields.find((f) => f.key === "type")?.options ?? []).map((o) => [o.value, o.label]),
);
const typeLabel = (scheme: DocSecurityScheme): string => (typeof scheme.type === "string" ? TYPE_LABELS.get(scheme.type) ?? scheme.type : "Choose a type");

/** A scheme name as a JSON pointer segment (RFC 6901). Valid names need no escaping; a name loaded from outside might. */
const pointerSegment = (name: string) => name.replace(/~/g, "~0").replace(/\//g, "~1");

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "1 set of operation properties" / "2 sets of operation properties": what a scheme's trait references are called for the user. */
const setsOfProperties = (n: number) => `${n} ${n === 1 ? "set" : "sets"} of operation properties`;
const list = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** The `{ server, operation, trait }` counts of a scheme's references as words: "1 server, 2 operations and 1 set of operation properties". */
function referenceWords(refs: SchemeReferences): string[] {
  return [
    refs.servers.length > 0 ? plural(refs.servers.length, "server") : null,
    refs.operations.length > 0 ? plural(refs.operations.length, "operation") : null,
    refs.traits.length > 0 ? setsOfProperties(refs.traits.length) : null,
  ].filter((p): p is string => p !== null);
}

export function AdvancedSection({ draft, options, selectedItem, onSelectItem }: SectionProps) {
  const { doc, update } = draft;
  const schemes = schemesOf(doc);
  const names = Object.keys(schemes);
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = uniqueProblems(draft.problems.concat(draft.serverProblems));
  const context = useMemo(() => buildReferenceContext(doc, { entityOptions: options.entityOptions }), [doc, options.entityOptions]);

  const active = selectedItem !== null && names.includes(selectedItem) ? selectedItem : names[0] ?? null;
  // A problem about the map itself (`/components`, `/components/securitySchemes`) belongs to no one scheme.
  const sectionProblems = problems.filter((p) => p.pointer === "/components" || p.pointer === "/components/securitySchemes");

  function addScheme() {
    const name = newSchemeName(doc);
    update((d) => addSecurityScheme(d, newSchemeName(d), { type: DEFAULT_TYPE }));
    onSelectItem(name);
  }

  return (
    <section aria-labelledby="advanced-heading" data-testid="section-advanced" className="space-y-space-6">
      <header className="flex items-start justify-between gap-space-4">
        <div className="space-y-space-1">
          <h2 id="advanced-heading" className="text-heading-3 text-foreground">Advanced</h2>
          <p className="text-body-small text-muted-foreground">
            Security schemes describe how clients authenticate. Servers, operations and operation properties (Trait) pick the ones they accept by name.
          </p>
        </div>
        {names.length > 0 && (
          <Button type="button" size="sm" variant="outline" onClick={addScheme} data-testid="scheme-add" className="gap-1.5">
            <Plus className="size-4" /> Add scheme
          </Button>
        )}
      </header>

      {sectionProblems.length > 0 && (
        <p data-testid="advanced-problems" className="text-body-small text-destructive">{[...new Set(sectionProblems.map((p) => p.message))].join("; ")}</p>
      )}

      {active === null ? (
        <div data-testid="scheme-empty" className="space-y-space-3 rounded-lg border border-dashed border-border p-space-6 text-center">
          <p className="text-heading-3 text-foreground">No security schemes yet</p>
          <p className="text-body-small text-muted-foreground">Security schemes are optional. Add one to let servers and operations say how they are protected.</p>
          <Button type="button" onClick={addScheme} data-testid="scheme-empty-add" className="gap-1.5"><Plus className="size-4" /> Add scheme</Button>
        </div>
      ) : (
        <div className="grid gap-space-6 @2xl:grid-cols-[14rem_1fr]">
          <ul aria-label="Security schemes" className="space-y-space-1">
            {names.map((name) => {
              const isActive = name === active;
              const broken = problemsByField(problems, `/components/securitySchemes/${pointerSegment(name)}`).length > 0;
              return (
                <li key={name}>
                  <button
                    type="button" data-testid={`scheme-row-${name}`} aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelectItem(name)}
                    className={cn(
                      "flex w-full items-center justify-between gap-space-2 rounded-lg px-space-3 py-space-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                      isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-body-small font-medium">{name}</span>
                      <span className="block truncate text-caption text-muted-foreground">{typeLabel(schemes[name])}</span>
                    </span>
                    {broken && (
                      <>
                        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
                        <span className="sr-only">has problems</span>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <SchemeForm key={active} draft={draft} name={active} problems={problems} context={context} onSelectItem={onSelectItem} />
        </div>
      )}
    </section>
  );
}

/**
 * The scheme's name. The text is local state: it commits (blur / Enter) only when it is valid and unused, so the document never holds a
 * broken name; otherwise the rule is shown and the document keeps the old name. Escape puts the committed name back.
 */
function SchemeNameInput({ name, error, problemFor, onCommit }: {
  name: string; error?: string; problemFor: (text: string) => string | null; onCommit: (next: string) => void;
}) {
  const [text, setText] = useState(name);
  const [seen, setSeen] = useState(name);
  // The committed name changed from outside (another scheme selected, a rename): show it.
  if (name !== seen) {
    setSeen(name);
    setText(name);
  }
  const edited = text !== name;
  const problem = edited ? problemFor(text) : null;
  const message = problem ?? error;
  const describedBy = ["scheme-key-hint", message ? "scheme-key-error" : null].filter(Boolean).join(" ");

  function commit() {
    if (!edited || problem) return;
    onCommit(text);
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      setText(name);
    }
  }

  return (
    <div className="space-y-space-1">
      <div className="flex items-baseline gap-space-1">
        <label htmlFor="scheme-key" className="block text-caption text-muted-foreground">Name</label>
        <span aria-hidden="true" data-testid="scheme-key-required" className="text-caption text-destructive">*</span>
      </div>
      <Input
        id="scheme-key" data-testid="scheme-key" value={text} autoComplete="off" spellCheck={false} aria-required
        aria-invalid={message ? true : undefined} aria-describedby={describedBy}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={onKeyDown}
      />
      <p id="scheme-key-hint" data-testid="scheme-key-hint" className="text-caption text-muted-foreground">
        The name servers, operations and operation properties use to refer to this scheme. Renaming it updates them.
      </p>
      {message && <p id="scheme-key-error" data-testid="scheme-key-error" className="text-body-small text-destructive">{message}</p>}
    </div>
  );
}

function SchemeForm({ draft, name, problems, context, onSelectItem }: {
  draft: DraftState; name: string; problems: DocumentProblem[]; context: ReturnType<typeof buildReferenceContext>;
  onSelectItem: (key: string | null) => void;
}) {
  const { doc, update } = draft;
  const scheme = schemesOf(doc)[name];
  const prefix = `/components/securitySchemes/${pointerSegment(name)}`;
  const refs = schemeReferences(doc, name);
  const words = referenceWords(refs);
  // A problem on the scheme itself (not on one of its properties): a name the components key rule refuses, for example.
  const nameError = problemMessage(problems.filter((p) => p.pointer === prefix));

  function rename(to: string) {
    if (!renameSecurityScheme(doc, name, to).success) return;
    update((d) => {
      const renamed = renameSecurityScheme(d, name, to);
      return renamed.success ? renamed.data : d;
    });
    onSelectItem(to);
  }

  function remove() {
    if (words.length > 0) {
      const where = list([
        refs.servers.length > 0 ? `${plural(refs.servers.length, "server")} (${refs.servers.join(", ")})` : null,
        refs.operations.length > 0 ? `${plural(refs.operations.length, "operation")} (${refs.operations.join(", ")})` : null,
        refs.traits.length > 0 ? `${setsOfProperties(refs.traits.length)} (${refs.traits.join(", ")})` : null,
      ].filter((p): p is string => p !== null));
      const count = refs.servers.length + refs.operations.length + refs.traits.length;
      if (!window.confirm(`Security scheme "${name}" is used by ${where}. Remove it and take it off ${count === 1 ? "that item" : "those items"}?`)) return;
    }
    update((d) => removeSecurityScheme(d, name));
    onSelectItem(null);
  }

  return (
    <div className="max-w-2xl space-y-space-4" data-testid="scheme-form">
      <SchemeNameInput name={name} error={nameError} problemFor={(text) => schemeNameProblem(doc, text, name)} onCommit={rename} />
      <p data-testid="scheme-usage" className="text-body-small text-muted-foreground">
        {words.length > 0 ? `Used by ${list(words)}` : "Not used by any server, operation or set of operation properties yet."}
      </p>
      <TemplateForm
        template={TEMPLATES.securityScheme} value={{ ...scheme }} idPrefix="scheme" errors={problems} errorPrefix={prefix} context={context}
        onChange={(next) => update((d) => updateSecurityScheme(d, name, next as DocSecurityScheme))}
      />
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={remove} data-testid="scheme-remove" className="gap-1.5 text-muted-foreground hover:text-destructive">
          <Trash2 className="size-4" /> Remove scheme
        </Button>
      </div>
    </div>
  );
}
