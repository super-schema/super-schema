/**
 * Line-level diff of the imported baseline against the user's current text.
 * Dependency-free LCS; schemas are small so O(n·m) is fine.
 */

export interface LineDiff {
  /** One entry per line of `current`; `changed` = not part of the common subsequence. */
  lines: { text: string; changed: boolean }[];
  /** Indexes into `current` before which at least one baseline line was removed. */
  removedAt: number[];
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

export function diffLines(baseline: string, current: string): LineDiff {
  const a = splitLines(baseline);
  const b = splitLines(current);

  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: LineDiff["lines"] = [];
  const removedAt: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ text: b[j], changed: false });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      lines.push({ text: b[j], changed: true });
      j++;
    } else {
      // baseline line i was removed; mark the spot in `current` (once per index)
      if (removedAt[removedAt.length - 1] !== j) removedAt.push(j);
      i++;
    }
  }
  return { lines, removedAt };
}
