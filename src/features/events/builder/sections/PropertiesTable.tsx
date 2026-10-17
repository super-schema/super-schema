"use client";

// src/features/events/builder/sections/PropertiesTable.tsx
// The properties of a set of message properties, as a table: Name · Type · Required · Description (+ allowed values as chips).
//
//  - READ-ONLY (built-in and library sets): a lock and a note ("Built in — can't be modified"), no inputs. Rows come from the
//    headers schema (`headers`: full fidelity, allowed values included) or, when the host only has the loader's summary, from `summary`.
//  - EDITABLE (local sets): add / remove rows, name, type (Text, Whole number, Decimal, True/false, Date-time, Link), required,
//    description and allowed values. It writes `spec.headers` (`{ type: "object", properties, required }`) through `onChange`, and
//    `undefined` when there are no rows (the caller removes `headers`). A row keeps its property's raw schema and every edit is merged
//    into it, so `const`, `format`, `pattern` and nested keys the table has no column for survive untouched.
//  - PINNED (`pinned`, a legacy trait whose headers come from an entity): the table says where the properties come from (`-pin-note`, the
//    entity linked): in place of "No properties" while it has no rows, as a line under the table once it has some (a row just added
//    and not named yet counts). The table owns the line because only it knows its rows.
// Test ids are `${idPrefix}-…`: `-table`, `-note`, `-empty`, `-pin-note`, `-add`, and per row (read-only: by name; editable: by position)
// `-row-<name>` / `-name-<i>`, `-type-<i>`, `-required-<i>`, `-description-<i>`, `-allowed-<i>` (+ `-chip-<j>`), `-remove-<i>`.
import { useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { Lock, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { JsonObject } from "@/lib/event-specs/types";
import type { PropertySummaryRow } from "@/lib/events/bundled-traits";
import { selectClass } from "../controls";
import { PINNED_HEADERS_LEAD, PINNED_PROPERTIES_LEAD } from "../labels";
import {
  allowedValues, descriptionOf, displayRowsFromHeaders, displayRowsFromSummary, duplicateNames, friendlyType, jsonEqual, PROPERTY_TYPES, readRows, setAllowedValues,
  setDescription, setType, typeLabel, writeHeaders, type DisplayRow, type PropertyRow, type PropertyType,
} from "../properties-schema";
import type { PinnedHeaders } from "../traits";

export interface PropertiesTableProps {
  /** Prefix of every id and test id. */
  idPrefix: string;
  /** The headers schema (`spec.headers`): the properties to show or edit. */
  headers?: unknown;
  /** Read-only only: the loader's property summary, used when the host has no headers schema. */
  summary?: ReadonlyArray<PropertySummaryRow>;
  /** Present = editable: called with the new headers schema, or `undefined` when no row is left. */
  onChange?: (next: JsonObject | undefined) => void;
  /** Force the read-only view even when `onChange` is given. */
  readOnly?: boolean;
  /** A line shown above the table with a lock (the reason it cannot be edited). */
  note?: ReactNode;
  /** The entity the headers come from (a legacy pin): the table says so instead of its empty-state line, and under its rows. */
  pinned?: PinnedHeaders;
  /** Disable every input of the editable table. */
  disabled?: boolean;
}

const HEAD = "px-space-2 py-space-1 text-left text-caption font-medium text-muted-foreground";
const CELL = "px-space-2 py-space-2 align-top text-body-small text-foreground";

export function LockedNote({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} data-testid={id} className="flex items-center gap-space-2 rounded-md border border-border bg-muted/30 px-space-3 py-space-2 text-body-small text-muted-foreground">
      <Lock aria-hidden="true" className="size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Where the properties of a pinned trait come from. `lead` is the sentence up to the entity: the table is empty, or it has rows of its own too. */
function PinnedNote({ id, pinned, lead, className }: { id: string; pinned: PinnedHeaders; lead: string; className: string }) {
  const name = pinned.href
    ? <Link href={pinned.href} className="font-medium text-primary hover:underline">{pinned.name}</Link>
    : <span className="font-medium text-foreground">{pinned.name}</span>;
  return (
    <p data-testid={id} className={className}>
      {lead} {name}{pinned.versionLabel ? ` v${pinned.versionLabel}` : ""}.
    </p>
  );
}
const EMPTY_NOTE = "text-body-small text-muted-foreground";
const ROWS_NOTE = "text-caption text-muted-foreground";

/** The allowed values of a property as chips; a `const` is "Always …". */
function AllowedChips({ id, allowed }: { id: string; allowed: DisplayRow["allowed"] }) {
  if (!allowed) return null;
  return (
    <div data-testid={id} className="mt-space-1 flex flex-wrap items-center gap-space-1">
      <span className="text-caption text-muted-foreground">{allowed.kind === "const" ? "Always" : "One of"}</span>
      {allowed.values.map((v, i) => (
        <Badge key={`${i}-${v}`} variant="secondary" data-testid={`${id}-chip-${i}`} className="font-mono">{v}</Badge>
      ))}
    </div>
  );
}

function ReadOnlyTable({ idPrefix, rows, pinned }: { idPrefix: string; rows: DisplayRow[]; pinned?: PinnedHeaders }) {
  if (rows.length === 0 && pinned) return <PinnedNote id={`${idPrefix}-pin-note`} pinned={pinned} lead={PINNED_PROPERTIES_LEAD} className={EMPTY_NOTE} />;
  if (rows.length === 0) return <p data-testid={`${idPrefix}-empty`} className="text-body-small text-muted-foreground">No properties.</p>;
  return (
    <>
      <div className="overflow-x-auto rounded-md border border-border">
        <table data-testid={`${idPrefix}-table`} className="w-full min-w-[32rem] border-collapse">
          <caption className="sr-only">Properties</caption>
          <thead className="border-b border-border bg-muted/30">
            <tr>
              <th scope="col" className={HEAD}>Name</th>
              <th scope="col" className={HEAD}>Type</th>
              <th scope="col" className={HEAD}>Required</th>
              <th scope="col" className={HEAD}>Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.name} data-testid={`${idPrefix}-row-${row.name}`}>
                <th scope="row" className={`${CELL} font-mono font-medium`}>{row.name}</th>
                <td className={CELL} data-testid={`${idPrefix}-row-${row.name}-type`}>{row.type}</td>
                <td className={CELL} data-testid={`${idPrefix}-row-${row.name}-required`}>
                  {row.required ? <Badge variant="secondary">Required</Badge> : <span className="text-muted-foreground">Optional</span>}
                </td>
                <td className={CELL}>
                  {row.description && <span data-testid={`${idPrefix}-row-${row.name}-description`}>{row.description}</span>}
                  <AllowedChips id={`${idPrefix}-row-${row.name}-allowed`} allowed={row.allowed} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pinned && <PinnedNote id={`${idPrefix}-pin-note`} pinned={pinned} lead={PINNED_HEADERS_LEAD} className={ROWS_NOTE} />}
    </>
  );
}

/** The allowed values input: chips plus one input. Enter or a comma adds the typed text, leaving the field adds it too. */
function AllowedValuesInput({ id, label, values, disabled, onChange }: { id: string; label: string; values: string[]; disabled?: boolean; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  function commit(text: string) {
    const fresh = text.split(/[,\n\r]+/).map((p) => p.trim()).filter((p, i, all) => p !== "" && !values.includes(p) && all.indexOf(p) === i);
    if (fresh.length > 0) onChange([...values, ...fresh]);
    setDraft("");
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    }
  }
  return (
    <div className="mt-space-1 space-y-space-1">
      {values.length > 0 && (
        <ul aria-label={`${label} added`} className="flex flex-wrap gap-space-1">
          {values.map((v, j) => (
            <li key={`${j}-${v}`} data-testid={`${id}-chip-${j}`} className="inline-flex items-center gap-space-1 rounded-4xl bg-secondary px-space-2 py-0.5 font-mono text-caption text-secondary-foreground">
              <span>{v}</span>
              <button
                type="button" aria-label={`Remove allowed value ${v}`} disabled={disabled} data-testid={`${id}-chip-${j}-remove`}
                onClick={() => onChange(values.filter((_, k) => k !== j))}
                className="rounded-full p-0.5 outline-none hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id} data-testid={id} aria-label={label} value={draft} disabled={disabled} autoComplete="off" placeholder="Allowed values (optional): type and press Enter"
        onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} onBlur={() => commit(draft)}
      />
    </div>
  );
}

/** A local identity for a row (never stored): rows are matched by it while their names change. */
let rowSequence = 0;
const nextRowId = () => `row-${++rowSequence}`;

function EditableTable({ idPrefix, headers, onChange, disabled, pinned }: { idPrefix: string; headers: unknown; onChange: (next: JsonObject | undefined) => void; disabled?: boolean; pinned?: PinnedHeaders }) {
  const [rows, setRows] = useState<PropertyRow[]>(() => readRows(headers, nextRowId));
  const [seen, setSeen] = useState<unknown>(headers);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // The headers changed from outside (another edit, a reload): show them, unless the rows already stand for them. A row that cannot be
  // stored yet (no name, a repeated name) is not in the headers and stays in the table.
  if (!jsonEqual(seen, headers)) {
    setSeen(headers);
    if (!jsonEqual(writeHeaders(rows, headers), headers)) setRows(readRows(headers, nextRowId));
  }
  const duplicates = duplicateNames(rows);

  function commit(next: PropertyRow[]) {
    setRows(next);
    const written = writeHeaders(next, headers);
    if (!jsonEqual(written, headers)) onChange(written);
  }
  const patchRow = (index: number, change: (row: PropertyRow) => PropertyRow) => commit(rows.map((r, i) => (i === index ? change(r) : r)));

  function addRow() {
    const id = nextRowId();
    commit([...rows, { id, name: "", schema: { type: "string" }, required: false }]);
    setJustAdded(id);
  }

  return (
    <div className="space-y-space-2">
      {rows.length === 0 ? (
        pinned
          ? <PinnedNote id={`${idPrefix}-pin-note`} pinned={pinned} lead={PINNED_PROPERTIES_LEAD} className={EMPTY_NOTE} />
          : <p data-testid={`${idPrefix}-empty`} className="text-body-small text-muted-foreground">No properties yet. Add the ones every message carries.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table data-testid={`${idPrefix}-table`} className="w-full min-w-[40rem] border-collapse">
            <caption className="sr-only">Properties</caption>
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th scope="col" className={HEAD}>Name</th>
                <th scope="col" className={HEAD}>Type</th>
                <th scope="col" className={HEAD}>Required</th>
                <th scope="col" className={HEAD}>Description</th>
                <th scope="col" className={HEAD}><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row, i) => {
                const n = i + 1;
                const name = row.name.trim();
                const problem = name === "" ? "Give it a name to save it." : duplicates.has(name) && rows.findIndex((r) => r.name.trim() === name) !== i ? `"${name}" is already used; this row is not saved.` : null;
                const friendly = friendlyType(row.schema);
                const allowed = allowedValues(row.schema);
                return (
                  <tr key={row.id} data-testid={`${idPrefix}-row-${i}`}>
                    <td className={CELL}>
                      <Input
                        id={`${idPrefix}-name-${i}`} data-testid={`${idPrefix}-name-${i}`} aria-label={`Property ${n}: name`} value={row.name} disabled={disabled}
                        autoComplete="off" spellCheck={false} aria-invalid={problem ? true : undefined} autoFocus={row.id === justAdded}
                        aria-describedby={problem ? `${idPrefix}-problem-${i}` : undefined} className="font-mono"
                        onChange={(e) => patchRow(i, (r) => ({ ...r, name: e.target.value }))}
                      />
                      {problem && <p id={`${idPrefix}-problem-${i}`} data-testid={`${idPrefix}-problem-${i}`} className="mt-space-1 text-caption text-destructive">{problem}</p>}
                    </td>
                    <td className={CELL}>
                      <select
                        id={`${idPrefix}-type-${i}`} data-testid={`${idPrefix}-type-${i}`} aria-label={`Property ${n}: type`} className={selectClass} disabled={disabled}
                        value={friendly ?? "other"} onChange={(e) => patchRow(i, (r) => ({ ...r, schema: setType(r.schema, e.target.value as PropertyType) }))}
                      >
                        {friendly === null && <option value="other" disabled>{typeLabel(row.schema)}</option>}
                        {PROPERTY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </td>
                    <td className={`${CELL} text-center`}>
                      <input
                        type="checkbox" id={`${idPrefix}-required-${i}`} data-testid={`${idPrefix}-required-${i}`} aria-label={`Property ${n}: required`}
                        className="size-4 accent-primary" checked={row.required} disabled={disabled}
                        onChange={(e) => patchRow(i, (r) => ({ ...r, required: e.target.checked }))}
                      />
                    </td>
                    <td className={CELL}>
                      <Input
                        id={`${idPrefix}-description-${i}`} data-testid={`${idPrefix}-description-${i}`} aria-label={`Property ${n}: description`}
                        value={descriptionOf(row.schema)} disabled={disabled} autoComplete="off" placeholder="What it means"
                        onChange={(e) => patchRow(i, (r) => ({ ...r, schema: setDescription(r.schema, e.target.value) }))}
                      />
                      <AllowedValuesInput
                        id={`${idPrefix}-allowed-${i}`} label={`Property ${n}: allowed values`} values={allowed?.values ?? []} disabled={disabled}
                        onChange={(values) => patchRow(i, (r) => ({ ...r, schema: setAllowedValues(r.schema, values) }))}
                      />
                    </td>
                    <td className={CELL}>
                      <button
                        type="button" aria-label={`Remove property ${name || n}`} data-testid={`${idPrefix}-remove-${i}`} disabled={disabled}
                        onClick={() => commit(rows.filter((_, k) => k !== i))}
                        className="rounded-md p-1 text-muted-foreground outline-none hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Button type="button" size="sm" variant="outline" onClick={addRow} disabled={disabled} data-testid={`${idPrefix}-add`} className="gap-1.5">
        <Plus className="size-4" /> Add property
      </Button>
      {pinned && rows.length > 0 && <PinnedNote id={`${idPrefix}-pin-note`} pinned={pinned} lead={PINNED_HEADERS_LEAD} className={ROWS_NOTE} />}
    </div>
  );
}

export function PropertiesTable({ idPrefix, headers, summary, onChange, readOnly, note, pinned, disabled }: PropertiesTableProps) {
  const editable = onChange !== undefined && !readOnly;
  return (
    <div data-testid={`${idPrefix}-properties`} className="space-y-space-2">
      {note && <LockedNote id={`${idPrefix}-note`}>{note}</LockedNote>}
      {editable ? (
        <EditableTable idPrefix={idPrefix} headers={headers} onChange={onChange} disabled={disabled} pinned={pinned} />
      ) : (
        <ReadOnlyTable idPrefix={idPrefix} rows={headers !== undefined || !summary ? displayRowsFromHeaders(headers) : displayRowsFromSummary(summary)} pinned={pinned} />
      )}
    </div>
  );
}
