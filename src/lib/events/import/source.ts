// src/lib/events/import/source.ts
// Step 1 of the AsyncAPI importer: file text → plain object. Pure — client-safe.
// Everything that can hurt later steps is rejected HERE, with a message the user can act on: oversized text, YAML alias/anchor
// bombs, duplicate keys, documents that are not AsyncAPI 3.x, keys that collide with `Object.prototype`, and nesting deep enough to
// overflow the recursive steps that follow. Nothing is truncated: a document is accepted whole or not at all.
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from "yaml";
import { err, ok, type Result } from "@/types/result";
import { MAX_IMPORT_CONTENT_BYTES } from "@/lib/compiler/import-limits";
import { isReservedKey } from "@/lib/event-specs/own-property";
import { jsonPointer } from "@/lib/event-specs/json-pointer";
import { MAX_ALIAS_COUNT, MAX_DOCUMENT_NODES, MAX_KEY_LENGTH, MAX_NESTING_DEPTH } from "./limits";
import { boundPointer, boundText } from "./bound";
import type { RawAsyncApi3 } from "./types";

export { MAX_ALIAS_COUNT, MAX_NESTING_DEPTH };

/** Longest piece of a parser's own error text echoed in a message. */
const MAX_ERROR_TEXT_LENGTH = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (code: string, message: string, extra?: { details?: object; suggestedFix?: string }) => err({ code, message, ...extra });

/** What the document was found to be, for the "not an AsyncAPI document" message. */
function describeKind(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * A `yaml` error as one line: "Map keys must be unique at line 2, column 1". The parser is told NOT to pretty-print its errors
 * (`prettyErrors: false`): its pretty-printer copies and scans the offending source line for EVERY error, so a text with many errors on one
 * long line (156 KiB of `[%,%,...` has about 78,000) took 4.3 s, 313 KiB 17 s and 1 MiB 145 s. Only the first error is ever shown, so its
 * position is worked out here, once, with a binary search in the line counter the parser already filled in.
 */
function yamlMessage(e: { message: string; pos: readonly number[] }, lines: LineCounter): string {
  const at = e.pos[0] === undefined || e.pos[0] < 0 ? undefined : lines.linePos(e.pos[0]);
  const text = e.message.split("\n")[0].replace(/:\s*$/, "");
  return boundText(at ? `${text} at line ${at.line}, column ${at.col}` : text, MAX_ERROR_TEXT_LENGTH);
}

/**
 * Every key must be short (and, when `forbiddenKeys`, safe), nothing may nest too deep, and the expanded document must stay small.
 * Iterative: a hostile file cannot overflow the stack here. Linear in the size of the document.
 */
function scan(root: unknown, forbiddenKeys: boolean): { message: string; details: object } | null {
  type Frame = { value: unknown; depth: number; parent: Frame | null; key: string | number };
  const stack: Frame[] = [{ value: root, depth: 0, parent: null, key: "" }];
  const pointerOf = (frame: Frame, key?: string): string => {
    const parts: Array<string | number> = key === undefined ? [] : [key];
    for (let f: Frame | null = frame; f !== null && f.parent !== null; f = f.parent) parts.unshift(f.key);
    return jsonPointer(...parts);
  };
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const { value, depth } = frame;
    nodes += 1;
    if (nodes > MAX_DOCUMENT_NODES) {
      return { message: `The document expands to more than ${MAX_DOCUMENT_NODES.toLocaleString("en-US")} values (aliases included); it was rejected as too large`, details: { limit: MAX_DOCUMENT_NODES } };
    }
    if (typeof value !== "object" || value === null) continue;
    if (depth >= MAX_NESTING_DEPTH) {
      return { message: `The document is nested more than ${MAX_NESTING_DEPTH} levels deep at "${boundText(pointerOf(frame), 120)}"`, details: { pointer: boundPointer(pointerOf(frame)), limit: MAX_NESTING_DEPTH } };
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) stack.push({ value: value[i], depth: depth + 1, parent: frame, key: i });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (key.length > MAX_KEY_LENGTH) {
        const pointer = pointerOf(frame, key);
        return {
          message: `A key is longer than ${MAX_KEY_LENGTH.toLocaleString("en-US")} characters (${key.length.toLocaleString("en-US")}, starting "${boundText(key, 40)}") at "${boundText(pointerOf(frame), 120)}"; keys that long are not names, so the document was rejected`,
          details: { pointer: boundPointer(pointer), length: key.length, limit: MAX_KEY_LENGTH },
        };
      }
      if (forbiddenKeys && isReservedKey(key)) {
        const pointer = pointerOf(frame, key);
        return { message: `The key "${boundText(key)}" at "${boundText(pointer, 120)}" is not allowed in an imported document (it collides with built-in JavaScript properties); rename it and import again`, details: { pointer: boundPointer(pointer), key: boundText(key) } };
      }
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1, parent: frame, key });
    }
  }
  return null;
}

/**
 * The first key that appears twice in one map, found with ONE walk over the parsed tree and a `Set` per map, so the cost is linear however many
 * keys one object has (the parser's own `uniqueKeys` check compares every key with every earlier one: 90,000 keys took 42 s, and 150,000 repeats of one
 * key 37 s). Scalar keys are compared by value and type, like the parser does; the tree is walked with a stack, never recursion.
 */
function firstDuplicateKey(doc: Document.Parsed, lines: LineCounter): string | null {
  const stack: unknown[] = [doc.contents];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isMap(node)) {
      const seen = new Set<unknown>();
      for (const pair of node.items) {
        const key = pair.key;
        if (isScalar(key)) {
          if (seen.has(key.value)) {
            const at = key.range ? lines.linePos(key.range[0]) : undefined;
            return `Map keys must be unique; "${boundText(key.value)}" appears more than once${at ? ` at line ${at.line}, column ${at.col}` : ""}`;
          }
          seen.add(key.value);
        } else if (isMap(key) || isSeq(key)) stack.push(key);
        if (isMap(pair.value) || isSeq(pair.value)) stack.push(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) if (isMap(item) || isSeq(item)) stack.push(item);
    }
  }
  return null;
}

/** `JSON.parse` keeps the last of two equal keys without a word; JSON is YAML, so the YAML parser's tree can say whether one repeats. */
function duplicateKeyIn(text: string): string | null {
  const lines = new LineCounter();
  return firstDuplicateKey(parseDocument(text, { uniqueKeys: false, lineCounter: lines, prettyErrors: false }), lines);
}

function parseJsonText(text: string): Result<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return fail("PARSE_ERROR", `The file is not valid JSON: ${e instanceof Error ? boundText(e.message, MAX_ERROR_TEXT_LENGTH) : "it could not be read"}`, { suggestedFix: "Fix the syntax error and import again." });
  }
  return ok(value);
}

function parseYamlText(text: string): Result<unknown> {
  const lines = new LineCounter();
  // repeated keys are found below, in linear time; errors are not pretty-printed (see `yamlMessage`): only the first is shown
  const doc = parseDocument(text, { uniqueKeys: false, lineCounter: lines, prettyErrors: false });
  const first = doc.errors[0];
  if (first && /call stack/i.test(first.message)) {
    // the `yaml` parser is recursive: a text nested far past the limit overflows ITS stack and says so as an error, not as a throw
    return fail("PARSE_ERROR", `The file is nested too deeply to read (the limit is ${MAX_NESTING_DEPTH} levels)`, { suggestedFix: "Flatten the nesting and import again." });
  }
  if (first) {
    const message = first.code === "MULTIPLE_DOCS" ? "The file holds more than one YAML document; import one AsyncAPI document at a time" : `The file is not valid YAML: ${yamlMessage(first, lines)}`;
    return fail("PARSE_ERROR", message, { suggestedFix: "Fix the syntax error and import again." });
  }
  const duplicate = firstDuplicateKey(doc, lines);
  if (duplicate) return fail("PARSE_ERROR", `The file is not valid YAML: ${duplicate}`, { suggestedFix: "Remove the repeated key and import again." });
  try {
    return ok(doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT }));
  } catch (e) {
    if (e instanceof ReferenceError) {
      return fail("PARSE_ERROR", `The document uses YAML aliases (&anchor / *alias) so heavily that it would expand without bound (more than ${MAX_ALIAS_COUNT} aliases); it was rejected`, {
        suggestedFix: "Write the repeated parts out in full, or use $ref to components instead of YAML aliases.",
      });
    }
    throw e;
  }
}

/**
 * The size bounds every later step relies on, for a document that did NOT come through `parseAsyncApiSource` (the importer always parses first;
 * `extractPayloads` and `mapAsyncApiToEventDocument` call this too, so that a caller who hands them an object cannot skip it): no object key longer
 * than 1,024 characters, nesting at most 256 levels, at most 2 million values. Linear. `__proto__`-like keys are not checked here: the later steps
 * store keys safely (`setOwn`).
 */
export function assertDocumentBounds(document: unknown): Result<void> {
  const problem = scan(document, false);
  return problem ? fail("PARSE_ERROR", problem.message, { details: problem.details }) : ok(undefined);
}

/**
 * YAML or JSON text → a plain object.
 * Rejects (all as `Result` errors, nothing throws): text over 1 MiB (`TOO_LARGE`); text that is not YAML/JSON, holds two documents, repeats a
 * key, uses more than 100 YAML aliases, nests deeper than 256 levels, has a key longer than 1,024 characters, or contains a `__proto__` / `constructor` / `prototype` key
 * (`PARSE_ERROR`); a document that is not an object or has no `asyncapi` field (`PARSE_ERROR`); anything but AsyncAPI 3.x (`UNSUPPORTED_VERSION`).
 */
export function parseAsyncApiSource(text: string): Result<RawAsyncApi3> {
  if (typeof text !== "string") return fail("PARSE_ERROR", "The file could not be read as text");
  // UTF-8 needs at least one byte per UTF-16 code unit, so a longer string is over the limit without counting its bytes.
  const bytes = text.length > MAX_IMPORT_CONTENT_BYTES ? Number.POSITIVE_INFINITY : new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_IMPORT_CONTENT_BYTES) {
    const size = Number.isFinite(bytes) ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "over 1 MB";
    return fail("TOO_LARGE", `The AsyncAPI document is too large to import (${size}); the limit is ${MAX_IMPORT_CONTENT_BYTES / 1024 / 1024} MB`, {
      suggestedFix: "Import a smaller document, or split it into several files.",
    });
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") return fail("PARSE_ERROR", "The file is empty");

  try {
    const looksLikeJson = body.trimStart().startsWith("{");
    const parsed = looksLikeJson ? parseJsonText(body) : parseYamlText(body);
    if (!parsed.success) return parsed;
    const value = parsed.data;

    if (!isObject(value)) {
      return fail("PARSE_ERROR", `This is not an AsyncAPI document: the file holds ${describeKind(value)}, not an object`, { suggestedFix: "Import an AsyncAPI 3.0 document (YAML or JSON)." });
    }
    const problem = scan(value, true);
    if (problem) return fail("PARSE_ERROR", problem.message, { details: problem.details });
    if (looksLikeJson) {
      const duplicate = duplicateKeyIn(body);
      if (duplicate) return fail("PARSE_ERROR", `The file is not valid JSON: ${duplicate}`, { suggestedFix: "Remove the repeated key and import again." });
    }

    const version = Object.hasOwn(value, "asyncapi") ? value.asyncapi : undefined;
    if (version === undefined) {
      const other = Object.hasOwn(value, "openapi") ? " It looks like an OpenAPI document." : "";
      return fail("PARSE_ERROR", `This is not an AsyncAPI document: the top-level "asyncapi" field is missing.${other}`, { suggestedFix: "Import an AsyncAPI 3.0 document." });
    }
    if (typeof version !== "string" || !/^3\.\d+(\.\d+)?(-.+)?$/.test(version.trim())) {
      return fail("UNSUPPORTED_VERSION", `AsyncAPI ${boundText(version, 40)} is not supported: only AsyncAPI 3.0 documents can be imported`, {
        details: { version: boundText(version, 80) },
        suggestedFix: "Upgrade the document to AsyncAPI 3.0 (the AsyncAPI CLI can do it: asyncapi convert --target-version 3.0.0) and import it again.",
      });
    }
    return ok(value as RawAsyncApi3);
  } catch (e) {
    // A pathological file can exhaust the stack inside a parser; it is still just a file the user must change.
    return fail("PARSE_ERROR", `The file could not be read${e instanceof RangeError ? " (it is nested too deeply)" : ""}: ${e instanceof Error ? boundText(e.message, MAX_ERROR_TEXT_LENGTH) : "unknown error"}`);
  }
}
