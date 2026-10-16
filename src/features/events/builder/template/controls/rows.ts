// src/features/events/builder/template/controls/rows.ts
// Rows with stable identities for the controls that edit a collection (list items, key/value rows). The rows live in local state so a
// row without a key yet (a draft the document cannot hold) survives, and so reordering never moves one row's typing state to another.
import { useState } from "react";

let counter = 0;
const nextRowId = () => {
  counter += 1;
  return counter;
};

export interface Row<V> { id: number; key: string; val: V }
export type RowData<V> = Array<{ key: string; val: V }>;

export const newRow = <V,>(key: string, val: V): Row<V> => ({ id: nextRowId(), key, val });
const withIds = <V,>(data: RowData<V>): Row<V>[] => data.map((r) => newRow(r.key, r.val));

/** A comparable form of a collection where "nothing" is the same whether it is undefined, `{}` or `[]`. */
function canon(v: unknown): string {
  if (v === undefined || v === null) return "∅";
  if (Array.isArray(v) && v.length === 0) return "∅";
  if (typeof v === "object" && Object.keys(v as object).length === 0) return "∅";
  return JSON.stringify(v);
}

/**
 * Rows for a collection value. `read` turns the document value into rows, `write` turns rows back into the value the control emits.
 * The rows are re-read only when the value changes to something the rows do not already produce (an edit from outside).
 */
export function useRows<V>(
  external: unknown,
  read: (external: unknown) => RowData<V>,
  write: (rows: RowData<V>) => unknown,
) {
  const [rows, setRows] = useState<Row<V>[]>(() => withIds(read(external)));
  const [seen, setSeen] = useState(external);
  if (!Object.is(seen, external)) {
    setSeen(external);
    if (canon(write(rows)) !== canon(external)) setRows(withIds(read(external)));
  }
  return [rows, setRows] as const;
}
