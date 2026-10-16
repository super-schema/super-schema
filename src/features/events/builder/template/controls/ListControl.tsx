"use client";

// src/features/events/builder/template/controls/ListControl.tsx
// kind "list": repeatable item cards rendering the item's fields, with add / remove / move up / move down. The items are an array,
// or (when the template has `mapKeyLabel`) a map keyed by a name the user chooses (server variables, channel parameters). Cards have
// stable identities, so reordering moves a card together with whatever the user was doing in it. An empty item stays (the card the
// user just added); an entry without a name yet is held locally until it has one, because a map cannot hold it.
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorsFor, isEmptyValue, singular } from "../value";
import { newRow, useRows, type Row, type RowData } from "./rows";
import type { ControlProps } from "./types";

type Item = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asItem = (v: unknown): Item => (isRecord(v) ? v : {});

const readArray = (external: unknown): RowData<Item> => (Array.isArray(external) ? external.map((v) => ({ key: "", val: asItem(v) })) : []);
const readMap = (external: unknown): RowData<Item> => (isRecord(external) ? Object.entries(external).map(([key, v]) => ({ key, val: asItem(v) })) : []);
const writeArray = (rows: RowData<Item>): Item[] => rows.map((r) => r.val);
function writeMap(rows: RowData<Item>): Record<string, Item> {
  const out: Record<string, Item> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key !== "" && !Object.hasOwn(out, key)) out[key] = row.val;
  }
  return out;
}

export function ListControl({ field, id, value, onChange, disabled, path, errors, renderFields }: ControlProps) {
  const mapMode = Boolean(field.mapKeyLabel);
  const noun = singular(field.label);
  const title = noun.charAt(0).toUpperCase() + noun.slice(1);
  const [rows, setRows] = useRows<Item>(value, mapMode ? readMap : readArray, mapMode ? writeMap : writeArray);
  const write = mapMode ? writeMap : writeArray;

  function commit(next: Array<Row<Item>>, emit = true) {
    setRows(next);
    if (emit) onChange(write(next));
  }
  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    [next[index], next[to]] = [next[to], next[index]];
    commit(next);
  }

  return (
    <div className="space-y-space-3">
      {rows.length > 0 && (
        <ul className="space-y-space-3">
          {rows.map((row, index) => {
            const name = row.key.trim();
            const duplicate = mapMode && name !== "" && rows.findIndex((r) => r.key.trim() === name) < index;
            const unnamed = mapMode && name === "" && !isEmptyValue(row.val);
            const keyProblem = duplicate ? `Another ${noun} already uses this name.` : unnamed ? `Enter a ${field.mapKeyLabel!.toLowerCase()} to save this entry.` : null;
            const itemPath = `${path}/${mapMode ? row.key : index}`;
            const itemErrors = errorsFor(errors, itemPath, { exact: true });
            const cardId = `${id}-${index}`;
            return (
              <li key={row.id}>
                <fieldset
                  data-testid={cardId} aria-describedby={itemErrors.length ? `${cardId}-error` : undefined}
                  className="space-y-space-3 rounded-md border border-border p-space-3"
                >
                  <legend className="px-space-1 text-caption text-muted-foreground">{`${title} ${index + 1}`}</legend>
                  <div className="flex justify-end gap-space-1">
                    <Button
                      type="button" variant="ghost" size="icon-xs" aria-label={`Move item ${index + 1} up`} data-testid={`${cardId}-up`}
                      disabled={disabled || index === 0} onClick={() => move(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      type="button" variant="ghost" size="icon-xs" aria-label={`Move item ${index + 1} down`} data-testid={`${cardId}-down`}
                      disabled={disabled || index === rows.length - 1} onClick={() => move(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      type="button" variant="ghost" size="icon-xs" aria-label={`Remove item ${index + 1}`} data-testid={`${cardId}-remove`}
                      disabled={disabled} onClick={() => commit(rows.filter((r) => r.id !== row.id))}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                  {mapMode && (
                    <div className="space-y-space-1">
                      <label htmlFor={`${cardId}-key`} className="block text-caption text-muted-foreground">{field.mapKeyLabel}</label>
                      <Input
                        id={`${cardId}-key`} data-testid={`${cardId}-key`} value={row.key} disabled={disabled} autoComplete="off" spellCheck={false}
                        aria-required aria-invalid={keyProblem ? true : undefined} aria-describedby={keyProblem ? `${cardId}-problem` : undefined}
                        onChange={(e) => commit(rows.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))}
                      />
                      {keyProblem && <p id={`${cardId}-problem`} data-testid={`${cardId}-problem`} className="text-caption text-destructive">{keyProblem}</p>}
                    </div>
                  )}
                  {itemErrors.length > 0 && (
                    <p id={`${cardId}-error`} data-testid={`${cardId}-error`} className="text-body-small text-destructive">{itemErrors.join(" ")}</p>
                  )}
                  {renderFields({
                    fields: field.fields ?? [],
                    value: row.val,
                    onChange: (next) => commit(rows.map((r) => (r.id === row.id ? { ...r, val: next } : r))),
                    idPrefix: cardId,
                    errorPrefix: itemPath,
                  })}
                </fieldset>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button" variant="outline" size="sm" data-testid={`${id}-add`} disabled={disabled}
        onClick={() => commit([...rows, newRow("", {})], !mapMode)}
      >
        <Plus aria-hidden="true" />
        {`Add ${noun}`}
      </Button>
    </div>
  );
}
