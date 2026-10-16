// src/features/events/builder/template/controls/editor-text.ts
// Pure text helpers of the JSON/YAML editor. No CodeMirror and no React in here: the textarea fallback, `JsonControl` and the lazy
// CodeMirror setup all use them, and they are tested without a DOM.

export interface JsonProblem {
  /** What the engine said, always ending in where ("line 3, column 1" or the engine's own wording of it). */
  message: string;
  /** Offset into the text the problem points at (0..text.length). */
  position: number;
  /** 1-based. */
  line: number;
  column: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/** The 1-based line and column of `position`; CRLF counts as one line break, `position` is clamped into the text. */
export function lineColumn(text: string, position: number): { line: number; column: number } {
  const end = clamp(position, 0, text.length);
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

/** The offset of 1-based `line` / `column`; past-the-end values land on the last offset of the text. */
function offsetOf(text: string, line: number, column: number): number {
  let currentLine = 1;
  let i = 0;
  while (currentLine < line && i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) currentLine++;
    i++;
  }
  return clamp(i + column - 1, 0, text.length);
}

const AT_POSITION = /\bposition (\d+)/i;
const AT_LINE_COLUMN = /\bline (\d+) column (\d+)/i;
const INPUT_ENDED = /end of (?:json input|data)|unexpected eof|unterminated/i;

/**
 * Where an engine's `JSON.parse` message points. V8 says `at position N` (newer versions add `(line L column C)`), Firefox says
 * `at line L column C`, Safari gives no place at all. The text ending too early, or no place given, points at the end.
 */
export function errorPosition(message: string, text: string): number {
  const position = AT_POSITION.exec(message);
  if (position) return clamp(Number(position[1]), 0, text.length);
  const lineColumnMatch = AT_LINE_COLUMN.exec(message);
  if (lineColumnMatch && !INPUT_ENDED.test(message)) return offsetOf(text, Number(lineColumnMatch[1]), Number(lineColumnMatch[2]));
  return text.length;
}

/** What is wrong with `text` as JSON, or null when it parses. Empty or blank text is not a problem (an optional field left empty). */
export function jsonProblem(text: string): JsonProblem | null {
  if (text.trim() === "") return null;
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    const engine = e instanceof Error && e.message !== "" ? e.message : "Invalid JSON";
    const position = errorPosition(engine, text);
    const { line, column } = lineColumn(text, position);
    const message = /\bline \d+/i.test(engine) ? engine : `${engine} (line ${line}, column ${column})`;
    return { message, position, line, column };
  }
}

/** An editor document stores every line break as LF, so text coming from outside is compared in that form. */
export function normalizeLineBreaks(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The smallest single edit turning `from` into `to` (common start and end kept), or null when they are equal. Replacing a document
 * with this edit, instead of all of it, keeps the cursor, the selection and the scroll position where they were.
 */
export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  const shortest = Math.min(from.length, to.length);
  let start = 0;
  while (start < shortest && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  // Never split a surrogate pair: both texts agree up to `start`, so one check is enough.
  if (start > 0 && isHighSurrogate(from.charCodeAt(start - 1))) start--;
  let endFrom = from.length;
  let endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom--;
    endTo--;
  }
  if (endFrom < from.length && isLowSurrogate(from.charCodeAt(endFrom))) {
    endFrom++;
    endTo++;
  }
  return { from: start, to: endFrom, insert: to.slice(start, endTo) };
}
