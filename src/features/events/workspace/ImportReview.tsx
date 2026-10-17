"use client";

// src/features/events/workspace/ImportReview.tsx
// The parts of the import dialog that show a result: the review of a document that can be imported (event name, counts, entities, the
// drafts note, warnings), the list of problems of one that cannot, and the failure of an import that ran. All wording is in
// `import-labels.ts`; the state is `use-asyncapi-import.ts`. Presentational: nothing here calls the server.
import { useState, type Ref } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ImportWarning } from "@/lib/events/import/types";
import type { AsyncApiImportPreview } from "@/services/events/asyncapi-import.service";
import type { ImportFailure, ImportProblem } from "./use-asyncapi-import";
import {
  builtInTraitsText, COUNT_LABELS, DRAFTS_HEADING, DRAFTS_NOTE, entitiesHeading, errorHeadline, EVENT_NAME_HINT, EVENT_NAME_LABEL,
  FAILED_HEADING, fieldCount, FORMAT_LABELS, fromDocumentTitle, IMPORT_WARNING_LABELS, LEFTOVERS_ACTION, LEFTOVERS_LEAD,
  leftoverEntity, leftoverEvent, NO_ENTITIES, NOTHING_CREATED, omittedWarningsCount, omittedWarningsNote, OUTCOME_UNKNOWN, problemCount,
  PROBLEMS_HEADING, PROBLEMS_LEAD, PROBLEMS_SHOWN, problemsMore, RENAMED_BADGE, renamedNote, showAllWarnings, warningCount, warningGroupLabel,
  warningPointer, WARNINGS_HEADING, WARNINGS_SHOWN_PER_GROUP,
} from "./import-labels";

/** Longest name the catalog accepts (`CATALOG_NAME_PATTERN`); the service owns the character rules and the client states them. */
const NAME_MAX_LENGTH = 128;

const sectionHeading = "text-body-small font-medium text-foreground";

// ── The review ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ReviewPanel({ preview, eventName, nameError, onEventNameChange, nameRef }: {
  preview: AsyncApiImportPreview;
  eventName: string;
  nameError: string | null;
  onEventNameChange: (name: string) => void;
  /** Takes the first focus of the step. */
  nameRef: Ref<HTMLInputElement>;
}) {
  return (
    <div data-testid="import-review" className="space-y-space-4">
      <div className="space-y-space-1">
        <label htmlFor="import-event-name" className="block text-caption text-muted-foreground">{EVENT_NAME_LABEL}</label>
        <Input
          ref={nameRef} id="import-event-name" data-testid="import-event-name" aria-required="true" autoComplete="off" spellCheck={false}
          maxLength={NAME_MAX_LENGTH} value={eventName} onChange={(e) => onEventNameChange(e.target.value)}
          aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? "import-event-name-error import-event-name-hint" : "import-event-name-hint"}
        />
        <p id="import-event-name-hint" data-testid="import-event-name-hint" className="text-caption text-muted-foreground">{EVENT_NAME_HINT}</p>
        {nameError && <p id="import-event-name-error" role="alert" data-testid="import-event-name-error" className="text-body-small text-destructive">{nameError}</p>}
        <p data-testid="import-title" className="text-caption text-muted-foreground">{fromDocumentTitle(preview.title)}</p>
      </div>

      <dl data-testid="import-counts" className="grid grid-cols-3 gap-space-2 sm:grid-cols-6">
        {(Object.keys(COUNT_LABELS) as Array<keyof typeof COUNT_LABELS>).map((key) => (
          // the term comes first in the DOM (screen readers read "Servers, 2"); the number is shown above its label
          <div key={key} className="flex flex-col-reverse rounded-lg border border-border/60 px-space-2 py-space-1 text-center">
            <dt className="text-caption text-muted-foreground">{COUNT_LABELS[key]}</dt>
            <dd data-testid={`import-count-${key}`} className="text-heading-3 text-foreground">{preview.counts[key]}</dd>
          </div>
        ))}
      </dl>

      <EntityList entities={preview.entities} />

      {preview.entities.length > 0 && (
        <section aria-labelledby="import-drafts-heading" data-testid="import-drafts-note" className="space-y-space-1 rounded-lg border border-warning/40 bg-warning/5 p-space-3">
          <h3 id="import-drafts-heading" className={sectionHeading}>{DRAFTS_HEADING}</h3>
          <p className="text-body-small text-foreground">{DRAFTS_NOTE}</p>
        </section>
      )}

      {preview.builtInTraits.length > 0 && (
        <p data-testid="import-builtin-traits" className="text-body-small text-foreground">{builtInTraitsText(preview.builtInTraits)}</p>
      )}

      <WarningGroups warnings={preview.warnings} />
    </div>
  );
}

function EntityList({ entities }: { entities: AsyncApiImportPreview["entities"] }) {
  return (
    <section aria-labelledby="import-entities-heading" className="space-y-space-1">
      <h3 id="import-entities-heading" data-testid="import-entities-heading" className={sectionHeading}>{entitiesHeading(entities.length)}</h3>
      {entities.length === 0 ? (
        <p data-testid="import-no-entities" className="text-body-small text-muted-foreground">{NO_ENTITIES}</p>
      ) : (
        <ul data-testid="import-entities" aria-labelledby="import-entities-heading" className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60">
          {entities.map((entity) => (
            <li key={entity.name} data-testid={`import-entity-${entity.name}`} className="px-space-3 py-space-2">
              <div className="flex flex-wrap items-center gap-x-space-2 gap-y-space-1">
                <span className="font-medium text-foreground">{entity.name}</span>
                {entity.renamed && <Badge variant="warning" data-testid={`import-entity-renamed-${entity.name}`}>{RENAMED_BADGE}</Badge>}
                <span className="ml-auto text-caption text-muted-foreground">{fieldCount(entity.fields)} · {FORMAT_LABELS[entity.format]}</span>
              </div>
              {entity.renamed && <p className="text-caption text-muted-foreground">{renamedNote(entity.requestedName)}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Warnings ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface WarningGroupData { code: string; items: ImportWarning[] }

/**
 * The warnings grouped by code, groups in the order of `IMPORT_WARNING_LABELS` (a code this build does not know comes last). The
 * importer's own "N more warnings were omitted" line is not a warning: it is taken out and its count returned.
 */
export function groupWarnings(warnings: readonly ImportWarning[]): { groups: WarningGroupData[]; omitted: number } {
  const byCode = new Map<string, ImportWarning[]>();
  let omitted = 0;
  for (const warning of warnings) {
    const count = omittedWarningsCount(warning);
    if (count !== null) {
      omitted += count;
      continue;
    }
    const list = byCode.get(warning.code);
    if (list) list.push(warning);
    else byCode.set(warning.code, [warning]);
  }
  const known = Object.keys(IMPORT_WARNING_LABELS);
  const order = [...known, ...[...byCode.keys()].filter((code) => !known.includes(code))];
  return { groups: order.flatMap((code) => (byCode.has(code) ? [{ code, items: byCode.get(code) as ImportWarning[] }] : [])), omitted };
}

function WarningGroups({ warnings }: { warnings: readonly ImportWarning[] }) {
  const { groups, omitted } = groupWarnings(warnings);
  if (groups.length === 0 && omitted === 0) return null;
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <section aria-labelledby="import-warnings-heading" data-testid="import-warnings" className="space-y-space-1">
      <h3 id="import-warnings-heading" className={`${sectionHeading} flex items-center gap-space-2`}>
        {WARNINGS_HEADING} <Badge variant="secondary" data-testid="import-warnings-count">{warningCount(total)}</Badge>
      </h3>
      <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
        {groups.map((group) => <WarningGroup key={group.code} group={group} />)}
      </ul>
      {omitted > 0 && <p data-testid="import-warnings-omitted" className="text-caption text-muted-foreground">{omittedWarningsNote(omitted)}</p>}
    </section>
  );
}

function WarningGroup({ group }: { group: WarningGroupData }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const id = `import-warning-group-${group.code}`;
  const shown = all ? group.items : group.items.slice(0, WARNINGS_SHOWN_PER_GROUP);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li data-testid={id}>
      <button
        type="button" aria-expanded={open} aria-controls={`${id}-list`} data-testid={`${id}-toggle`} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-space-2 px-space-3 py-space-2 text-left text-body-small text-foreground outline-none hover:bg-accent/30 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">{warningGroupLabel(group.code)}</span>
        <Badge variant="secondary" data-testid={`${id}-count`}>{group.items.length}</Badge>
      </button>
      {open && (
        <div id={`${id}-list`} className="space-y-space-2 px-space-3 pb-space-3">
          <ul data-testid={`${id}-list`} className="space-y-space-2">
            {shown.map((warning, i) => (
              <li key={i} data-testid={`${id}-item`} className="text-body-small">
                <p className="text-foreground">{warning.message}</p>
                <p className="font-mono text-caption text-muted-foreground">{warningPointer(warning.pointer)}</p>
              </li>
            ))}
          </ul>
          {shown.length < group.items.length && (
            <Button type="button" variant="link" size="xs" data-testid={`${id}-all`} onClick={() => setAll(true)}>{showAllWarnings(group.items.length)}</Button>
          )}
        </div>
      )}
    </li>
  );
}

// ── Problems and failures ──────────────────────────────────────────────────────────────────────────────────────────────

/** The problems of a document the validator refused: message and pointer each, the first `PROBLEMS_SHOWN`, then a count. */
function ProblemList({ problems }: { problems: readonly ImportProblem[] }) {
  const shown = problems.slice(0, PROBLEMS_SHOWN);
  return (
    <>
      <ul data-testid="import-problems" aria-label={PROBLEMS_HEADING} className="max-h-64 space-y-space-2 overflow-y-auto">
        {shown.map((problem, i) => (
          <li key={i} data-testid={`import-problem-${i}`} className="rounded-md border border-border/50 p-space-3">
            <p className="text-body-small text-foreground">{problem.message}</p>
            <p className="font-mono text-caption text-muted-foreground">{warningPointer(problem.pointer)}</p>
          </li>
        ))}
      </ul>
      {problems.length > shown.length && <p data-testid="import-problems-more" className="text-caption text-muted-foreground">{problemsMore(problems.length - shown.length)}</p>}
    </>
  );
}

/** A document the validator refused: what is wrong, and that nothing was created. There is nothing to import. */
export function ProblemsPanel({ failure }: { failure: ImportFailure }) {
  return (
    <div data-testid="import-problems-panel" className="space-y-space-3">
      <div role="alert" className="space-y-space-1">
        <h3 className={`${sectionHeading} text-destructive`}>{PROBLEMS_HEADING}</h3>
        <p className="text-body-small text-foreground">{PROBLEMS_LEAD}</p>
        <p data-testid="import-problems-count" className="text-caption text-muted-foreground">{problemCount(failure.problems.length)}</p>
      </div>
      <ProblemList problems={failure.problems} />
    </div>
  );
}

/** A refusal that has no list (an unreadable file, AsyncAPI 2.x, a reference cycle, a timeout, …): its headline and the server's words. */
export function InputFailureAlert({ failure }: { failure: ImportFailure }) {
  const headline = errorHeadline(failure.code);
  return (
    <div role="alert" data-testid="import-error" className="space-y-space-1 text-body-small text-destructive">
      {headline && <p data-testid="import-error-headline" className="font-medium">{headline}</p>}
      <p data-testid="import-error-text">{failure.text}</p>
    </div>
  );
}

/**
 * An import that ran and failed. The server undoes what it created, so the sentence is "Nothing was created." — unless it could not
 * delete something (it names what remains) or the connection failed (then nobody knows, and nothing is claimed).
 */
export function FailurePanel({ failure, eventName }: { failure: ImportFailure; eventName: string }) {
  const headline = errorHeadline(failure.code) ?? FAILED_HEADING;
  return (
    <div role="alert" data-testid="import-failure" className="space-y-space-3 text-body-small">
      <div className="space-y-space-1">
        <p data-testid="import-failure-headline" className="font-medium text-destructive">{headline}</p>
        <p data-testid="import-failure-text" className="text-foreground">{failure.text}</p>
      </div>
      {failure.leftovers.length > 0 ? (
        <div data-testid="import-leftovers" className="space-y-space-1">
          <p className="text-foreground">{LEFTOVERS_LEAD}</p>
          <ul className="list-disc space-y-space-1 pl-space-4 text-foreground">
            {failure.leftovers.map((leftover, i) => (
              <li key={i}>{leftover.kind === "entity" ? leftoverEntity(leftover.name) : leftoverEvent(eventName)}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">{LEFTOVERS_ACTION}</p>
        </div>
      ) : failure.unknownOutcome ? (
        <p data-testid="import-outcome-unknown" className="text-foreground">{OUTCOME_UNKNOWN}</p>
      ) : (
        <p data-testid="import-nothing-created" className="text-foreground">{NOTHING_CREATED}</p>
      )}
      {failure.problems.length > 0 && <ProblemList problems={failure.problems} />}
    </div>
  );
}
