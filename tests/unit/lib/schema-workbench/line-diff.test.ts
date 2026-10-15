import { describe, expect, it } from "vitest";
import { diffLines } from "@/lib/schema-workbench/line-diff";

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
