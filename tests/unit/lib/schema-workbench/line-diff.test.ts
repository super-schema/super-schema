import { describe, expect, it } from "vitest";
import { MAX_LCS_CELLS, diffLines } from "@/lib/schema-workbench/line-diff";

const changed = (d: ReturnType<typeof diffLines>) =>
  d.lines.filter((l) => l.changed).map((l) => l.text);

describe("diffLines", () => {
  it("marks nothing for identical text", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(changed(d)).toEqual([]);
    expect(d.removedAt).toEqual([]);
  });

  it("marks an edited line", () => {
    expect(changed(diffLines("a\nb\nc", "a\nB\nc"))).toEqual(["B"]);
  });

  it("marks an inserted line", () => {
    expect(changed(diffLines("a\nc", "a\nb\nc"))).toEqual(["b"]);
  });

  it("records where a baseline line was removed", () => {
    const d = diffLines("a\nb\nc", "a\nc");
    expect(changed(d)).toEqual([]);
    expect(d.removedAt).toEqual([1]);
  });

  it("treats everything as changed against an empty baseline", () => {
    expect(changed(diffLines("", "a\nb"))).toEqual(["a", "b"]);
  });

  it("ignores a trailing newline difference", () => {
    expect(changed(diffLines("a\nb\n", "a\nb"))).toEqual([]);
  });

  it("returns no lines for empty current", () => {
    const d = diffLines("a", "");
    expect(d.lines).toEqual([]);
    expect(d.removedAt).toEqual([0]);
  });
});

describe("diffLines — scale", () => {
  const big = (n: number, tweak?: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => (tweak ? tweak(i) : `line ${i}`)).join("\n");

  it("returns immediately for identical large text", () => {
    const text = big(50_000);
    const start = performance.now();
    const d = diffLines(text, text);
    expect(performance.now() - start).toBeLessThan(500);
    expect(d.lines).toHaveLength(50_000);
    expect(changed(d)).toEqual([]);
  });

  it("keeps a one-line edit in a large file cheap and exact", () => {
    const base = big(50_000);
    const edited = big(50_000, (i) => (i === 25_000 ? "EDITED" : `line ${i}`));
    const start = performance.now();
    const d = diffLines(base, edited);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(changed(d)).toEqual(["EDITED"]);
  });

  it("adjusts removedAt for the trimmed prefix and for removal at the end", () => {
    expect(diffLines("a\nb\nc\nd", "a\nb\nc").removedAt).toEqual([3]);
    expect(diffLines("a\nb\nc\nd\ne", "a\nc\nd\ne").removedAt).toEqual([1]);
  });

  it("falls back to a linear comparison above the LCS cap instead of exhausting memory", () => {
    const n = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 50;
    const base = big(n, (i) => `a${i}`);
    const cur = big(n, (i) => (i % 2 === 0 ? `b${i}` : `a${i}`));
    const start = performance.now();
    const d = diffLines(base, cur);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(d.lines).toHaveLength(n);
    // lines that still exist in the baseline are not flagged; rewritten ones are
    expect(d.lines[0].changed).toBe(true);
    expect(d.lines[1].changed).toBe(false);
  });
});

