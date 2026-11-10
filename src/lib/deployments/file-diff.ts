import { MAX_LCS_CELLS } from "@/lib/schema-workbench/line-diff";

export interface FileDiffLine { kind: "context" | "added" | "removed"; text: string; oldLine?: number; newLine?: number }
const lines = (value: string) => value === "" ? [] : value.replace(/\n$/, "").split("\n");
/** Exact line comparison with bounded LCS work; large changed blocks use a valid full replacement. */
export function fileDiff(before: string, after: string): FileDiffLine[] | null {
  if (before.length + after.length > 1_500_000) return null;
  const a = lines(before), b = lines(after);
  if (a.length + b.length > 30_000) return null;
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const old = a.slice(prefix, a.length - suffix), next = b.slice(prefix, b.length - suffix);
  const rows: FileDiffLine[] = [];
  let oldLine = 1, newLine = 1;
  const same = (text: string) => rows.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ });
  const remove = (text: string) => rows.push({ kind: "removed", text, oldLine: oldLine++ });
  const add = (text: string) => rows.push({ kind: "added", text, newLine: newLine++ });
  a.slice(0, prefix).forEach(same);
  const width = next.length + 1;
  if ((old.length + 1) * width <= MAX_LCS_CELLS) {
    const lcs = new Uint32Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) {
      lcs[i * width + j] = old[i] === next[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) { same(old[i++]); j++; }
      else if (i < old.length && (j === next.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) remove(old[i++]);
      else add(next[j++]);
    }
  } else { old.forEach(remove); next.forEach(add); }
  b.slice(b.length - suffix).forEach(same);
  return rows;
}
