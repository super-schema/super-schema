"use client";

// src/features/events/builder/template/controls/KeyValueControl.tsx
// kind "keyValue": rows of a name and a value, with add / remove. Rows live in local state so a row without a name (a draft the
// document cannot hold) survives; only rows with a name, first of each name, are written. A value that is not text (a binding map
// whose values are objects) is shown as JSON and left untouched until its row is edited.
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { newRow, useRows, type RowData } from "./rows";
import type { ControlProps } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const read = (external: unknown): RowData<unknown> => (isRecord(external) ? Object.entries(external).map(([key, val]) => ({ key, val })) : []);

function write(rows: RowData<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key !== "" && !Object.hasOwn(out, key)) out[key] = row.val;
  }
  return out;
}

const display = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

export function KeyValueControl({ field, id, value, onChange, disabled }: ControlProps) {
  const [rows, setRows] = useRows<unknown>(value, read, write);

  function commit(next: typeof rows, emit = true) {
    setRows(next);
    if (emit) onChange(write(next));
  }

  return (
    <div className="space-y-space-2">
      {rows.map((row, index) => {
        const name = row.key.trim();
        const duplicate = name !== "" && rows.findIndex((r) => r.key.trim() === name) < index;
        const orphan = name === "" && display(row.val) !== "";
        const problem = duplicate ? "Another row already uses this name." : orphan ? "Enter a name for this row, or it is left out." : null;
        const problemId = `${id}-${index}-problem`;
        return (
          <div key={row.id} className="space-y-space-1">
            <div className="flex items-start gap-space-2">
              <Input
                aria-label={`${field.label}: name ${index + 1}`} data-testid={`${id}-${index}-key`} value={row.key} placeholder="Name"
                disabled={disabled} autoComplete="off" spellCheck={false} aria-invalid={problem ? true : undefined} aria-describedby={problem ? problemId : undefined}
                onChange={(e) => commit(rows.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))}
              />
              <Input
                aria-label={`${field.label}: value ${index + 1}`} data-testid={`${id}-${index}-value`} value={display(row.val)} placeholder="Value"
                disabled={disabled} autoComplete="off"
                onChange={(e) => commit(rows.map((r) => (r.id === row.id ? { ...r, val: e.target.value } : r)))}
              />
              <Button
                type="button" variant="ghost" size="icon-sm" aria-label={`Remove row ${index + 1}`} data-testid={`${id}-${index}-remove`} disabled={disabled}
                onClick={() => commit(rows.filter((r) => r.id !== row.id))}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            {problem && <p id={problemId} data-testid={problemId} className="text-caption text-destructive">{problem}</p>}
          </div>
        );
      })}
      <Button
        type="button" variant="outline" size="sm" data-testid={`${id}-add`} disabled={disabled}
        onClick={() => commit([...rows, newRow("", "")], false)}
      >
        <Plus aria-hidden="true" />
        Add row
      </Button>
    </div>
  );
}
