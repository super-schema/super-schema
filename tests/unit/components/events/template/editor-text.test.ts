import { describe, expect, it } from "vitest";
import {
  errorPosition, jsonProblem, lineColumn, minimalChange, normalizeLineBreaks,
} from "@/features/events/builder/template/controls/editor-text";

describe("lineColumn", () => {
  it("counts lines and columns from 1", () => {
    expect(lineColumn("abc", 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn("abc", 2)).toEqual({ line: 1, column: 3 });
    expect(lineColumn("ab\ncd\nef", 3)).toEqual({ line: 2, column: 1 });
    expect(lineColumn("ab\ncd\nef", 7)).toEqual({ line: 3, column: 2 });
  });

  it("treats CRLF as one line break and clamps a position past the end", () => {
    expect(lineColumn("ab\r\ncd", 4)).toEqual({ line: 2, column: 1 });
    expect(lineColumn("ab\ncd", 99)).toEqual({ line: 2, column: 3 });
    expect(lineColumn("ab", -5)).toEqual({ line: 1, column: 1 });
  });
});

describe("errorPosition: where an engine's JSON.parse message points", () => {
  const text = '{\n  "a": 1,\n}';

  it("reads V8's `at position N`", () => {
    expect(errorPosition("Expected double-quoted property name in JSON at position 11 (line 3 column 1)", text)).toBe(11);
    expect(errorPosition("Unexpected token } in JSON at position 5", text)).toBe(5);
  });

  it("reads Firefox's `at line L column C`", () => {
    // line 3 column 1 of '{\n  "a": 1,\n}' is the closing brace, the 13th character
    expect(errorPosition("JSON.parse: expected double-quoted property name at line 3 column 1 of the JSON data", text)).toBe(12);
  });

  it("points at the end of the text when the input ends too early (V8, Firefox and Safari wording)", () => {
    expect(errorPosition("Unexpected end of JSON input", "[1,")).toBe(3);
    expect(errorPosition("JSON.parse: unexpected end of data at line 1 column 4 of the JSON data", "[1,")).toBe(3);
    expect(errorPosition("JSON Parse error: Unexpected EOF", "[1,")).toBe(3);
  });

  it("falls back to the end of the text when the message has no location at all", () => {
    expect(errorPosition("JSON Parse error: Unrecognized token '}'", "[1, }")).toBe(5);
  });

  it("never points past the end of the text", () => {
    expect(errorPosition("Unexpected token in JSON at position 400", "[1,")).toBe(3);
  });
});

describe("jsonProblem", () => {
  it("is null for valid JSON of any shape and for empty text", () => {
    for (const ok of ['{"a":1}', "[1,2]", '"text"', "42", "false", "null", "", "   \n  "]) expect(jsonProblem(ok)).toBeNull();
  });

  it("describes invalid JSON with a message, a position and a line and column", () => {
    const text = '{\n  "a": 1,\n}';
    const problem = jsonProblem(text);
    expect(problem).not.toBeNull();
    expect(problem?.message.length).toBeGreaterThan(0);
    expect(problem?.position).toBeGreaterThanOrEqual(0);
    expect(problem?.position).toBeLessThanOrEqual(text.length);
    expect(problem?.line).toBe(3);
    expect(problem?.column).toBe(1);
  });

  it("always names the line and column in the message, even when the engine does not", () => {
    const problem = jsonProblem('{ "a": ');
    expect(problem?.message).toMatch(/line 1/i);
    expect(problem?.message).toMatch(/column \d+/i);
    // not twice when the engine already said so
    expect(problem?.message.match(/line 1/gi)).toHaveLength(1);
  });

  it("points at the end for text that stops short", () => {
    const text = '{ "a": ';
    expect(jsonProblem(text)?.position).toBe(text.length);
  });
});

describe("minimalChange: the smallest edit that turns one text into another", () => {
  const apply = (from: string, change: { from: number; to: number; insert: string }) => from.slice(0, change.from) + change.insert + from.slice(change.to);

  it("is null for equal texts", () => {
    expect(minimalChange("same", "same")).toBeNull();
    expect(minimalChange("", "")).toBeNull();
  });

  it("replaces only the part in the middle", () => {
    expect(minimalChange("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(minimalChange('{"a": 1}', '{"a": 22}')).toEqual({ from: 6, to: 7, insert: "22" });
  });

  it("handles an insertion at the start, at the end, a deletion and a full replacement", () => {
    expect(minimalChange("b", "ab")).toEqual({ from: 0, to: 0, insert: "a" });
    expect(minimalChange("a", "ab")).toEqual({ from: 1, to: 1, insert: "b" });
    expect(minimalChange("abc", "ac")).toEqual({ from: 1, to: 2, insert: "" });
    expect(minimalChange("abc", "xyz")).toEqual({ from: 0, to: 3, insert: "xyz" });
    expect(minimalChange("", "abc")).toEqual({ from: 0, to: 0, insert: "abc" });
    expect(minimalChange("abc", "")).toEqual({ from: 0, to: 3, insert: "" });
  });

  it("does not let the prefix and the suffix overlap (repeated characters)", () => {
    const change = minimalChange("aaa", "aaaa");
    expect(change).not.toBeNull();
    expect(apply("aaa", change!)).toBe("aaaa");
    const shrink = minimalChange("abab", "ab");
    expect(apply("abab", shrink!)).toBe("ab");
  });

  it("always produces a change that reproduces the new text", () => {
    const samples = ["", "a", "ab", "abc", "aXc", "line1\nline2", "line1\nline2\nline3", "{\n  \"a\": 1\n}", "{\n  \"a\": 2\n}", "😀", "a😀b", "a😁b"];
    for (const a of samples) for (const b of samples) {
      const change = minimalChange(a, b);
      expect(apply(a, change ?? { from: 0, to: 0, insert: "" })).toBe(change === null ? a : b);
      if (change === null) expect(a).toBe(b);
    }
  });

  it("does not cut a surrogate pair in two", () => {
    const change = minimalChange("a😀b", "a😁b");
    expect(change).not.toBeNull();
    expect(change?.insert).toBe("😁");
    expect(change!.to - change!.from).toBe(2);
  });
});

describe("normalizeLineBreaks", () => {
  it("turns CRLF and lone CR into LF, the way an editor document stores them", () => {
    expect(normalizeLineBreaks("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeLineBreaks("plain")).toBe("plain");
  });
});
