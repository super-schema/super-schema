/**
 * Line-level diff of the imported baseline against the user's current text.
 * Dependency-free. Runs on every keystroke, so it is built to stay cheap:
 * identical text returns immediately, the common prefix/suffix is trimmed (a
 * typical edit leaves a tiny middle), and the LCS table is capped — above the
 * cap it falls back to a linear multiset comparison.
 */

export interface LineDiff {
  /** One entry per line of `current`; `changed` = not part of the common subsequence. */
  lines: { text: string; changed: boolean }[];
  /** Indexes into `current` before which at least one baseline line was removed
   *  (`current.length` = removed after the last line). */
  removedAt: number[];
}

/** Max LCS table cells for the trimmed middle; larger diffs use the linear fallback. */
export const MAX_LCS_CELLS = 2_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/** LCS diff of two (already trimmed) line arrays. `removedAt` is relative to `b`. */
function lcsDiff(a: string[], b: string[]): { changed: boolean[]; removedAt: number[] } {
  const cols = b.length + 1;
  // Flat typed table: lcs[i * cols + j] = LCS length of a[i..] and b[j..]
  const lcs = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }

  const changed: boolean[] = [];
  const removedAt: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      changed.push(false);
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i * cols + j + 1] >= lcs[(i + 1) * cols + j])) {
      changed.push(true);
      j++;
    } else {
      if (removedAt[removedAt.length - 1] !== j) removedAt.push(j);
      i++;
    }
  }
  return { changed, removedAt };
}

/** Linear fallback: a current line is "changed" if the baseline has no unused copy of it. */
function multisetDiff(a: string[], b: string[]): { changed: boolean[]; removedAt: number[] } {
  const available = new Map<string, number>();
  for (const line of a) available.set(line, (available.get(line) ?? 0) + 1);

  const changed = b.map((line) => {
    const n = available.get(line) ?? 0;
    if (n === 0) return true;
    available.set(line, n - 1);
    return false;
  });

  let leftover = 0;
  for (const n of available.values()) leftover += n;
  // Positions are unknown here; mark a single removal at the end of the block.
  return { changed, removedAt: leftover > 0 ? [b.length] : [] };
}

export function diffLines(baseline: string, current: string): LineDiff {
  if (baseline === current) {
    return { lines: splitLines(current).map((text) => ({ text, changed: false })), removedAt: [] };
  }

  const a = splitLines(baseline);
  const b = splitLines(current);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const mid =
    midA.length === 0 || midB.length === 0 || (midA.length + 1) * (midB.length + 1) <= MAX_LCS_CELLS
      ? lcsDiff(midA, midB)
      : multisetDiff(midA, midB);

  const lines: LineDiff["lines"] = [];
  for (let i = 0; i < prefix; i++) lines.push({ text: b[i], changed: false });
  midB.forEach((text, i) => lines.push({ text, changed: mid.changed[i] }));
  for (let i = b.length - suffix; i < b.length; i++) lines.push({ text: b[i], changed: false });

  return { lines, removedAt: mid.removedAt.map((index) => index + prefix) };
}
