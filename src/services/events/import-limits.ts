// src/services/events/import-limits.ts
// Every bound of the AsyncAPI import in ONE place. The file is capped at 1 MiB (`checkImportSize`), and `parseAsyncApiSource` (the pure
// layer, `src/lib/events/import/`) refuses nesting over 256 levels, keys over 1,024 characters, more than 2 million values and more than 100
// YAML aliases, all in linear time (the YAML read itself is linear too, but see the error flood in KNOWN LIMITATION below). These are the
// bounds on what the import then DOES with the parsed document, all checked BEFORE the slow steps and the first write, so a document over
// any of them creates no event and no entity and says which limit it hit.
//
// Nothing in the importers or the AsyncAPI parser can be interrupted (they are long synchronous stretches of CPU, so a timer cannot fire in
// the middle of them): the only protection is to bound what they are given, and the bounds below do NOT make the cost small, only
// bounded per piece. Measured on the real code:
// - the JSON Schema and Avro importers are linear (a 256 KiB schema: 8 ms);
// - the Protobuf importer is quadratic in the fields of ONE message (densest case, enum-typed fields: 128 KiB 6.1 s, 64 KiB about 1 - 1.5 s,
//   32 KiB 0.3 s, 16 KiB 0.1 s);
// - the AsyncAPI parser (Spectral) costs roughly 1 - 2.5 s per MiB of its input AFTER every `$ref` is replaced by its target, depending on
//   the shape (about 5 s at 4 MiB for the densest allOf / oneOf / items shapes, hence the 2 MiB limit), and a 2 KiB document of references
//   to a shared definition can be tens of MB for it (`checkExpandedSize`);
// - it ALSO grows roughly with the square of the number of keys of any one object, whatever the bytes (15,000 keys 3.6 s, 30,000 13.5 s,
//   109,623 keys in 1 MiB 95 s), and the mapper's de-duplication of a list is quadratic too (one `enum` of 115,136 strings: 11.5 s), hence
//   the caps on the entries of an object and of a list (`checkEntryCounts`).
// KNOWN LIMITATION: those caps bound ONE object, not the file, which can hold about sixty of them. Measured at the file cap: 60 channels of
// 1,999 `parameters` entries each, about 9.4 s in the parser (119,941 diagnostics); 70 `x-ext` objects of 1,999 keys, about 3.7 s. The
// server's event loop is blocked meanwhile. Lowering the cap barely helps (500 entries: still 5.3 s). The real bound is to run the parser in a
// worker thread with a hard timeout, which is a follow-up, not part of this feature.
// The YAML read has a residual of its own: a file that is mostly syntax errors costs 5 - 9 s at 1 MiB (linear, and the cost is the `yaml`
// package creating its own error objects, one stack trace each), next to the ~10 s `parser.validate` case above. Setting
// `Error.stackTraceLimit = 0` around the parse would cut it below 2 s and was deliberately NOT done (it is a process-wide switch).
// A `$ref` that many messages share is inlined once per message, so reuse is counted per use. Fields are rows inside one transaction that
// holds the tenant's name lock (it blocks every name-writing operation of the tenant).
import { boundText as boundForDisplay } from "@/lib/events/import/bound";
import { refTargetSegments } from "@/lib/events/import/refs";
import type { ExtractedPayload } from "@/lib/events/import";
import { escapePointerSegment, jsonPointer, localRef, resolveLocalRef } from "@/lib/event-specs/json-pointer";
import { err, ok, type Result } from "@/types/result";

/** Most entities one import may create (payloads, headers and their definitions together). */
export const MAX_IMPORT_ENTITIES = 500;
/** Most message payloads (and importable headers) one import may read: one entity each at least, so over this the entity cap is certain. */
export const MAX_IMPORT_PAYLOADS = 500;
/** Largest JSON Schema or Avro payload an importer is given (serialized JSON length, `$ref`s inlined). */
export const MAX_JSON_PAYLOAD_BYTES = 256 * 1024;
/** Largest Protobuf payload an importer is given (source length). 64 KiB is about 1 - 1.5 s worst case (measured, 4,800 compact enum-typed fields) and still holds a fully legitimate 2,000-field message. */
export const MAX_PROTOBUF_PAYLOAD_BYTES = 64 * 1024;
/** Largest total of all payloads handed to importers, a schema used by N messages counting N times. */
export const MAX_TOTAL_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** Largest total of DISTINCT Protobuf sources (each is parsed once, and parsing is quadratic): a 64 KiB and a 32 KiB source are about 1.5 s of blocked server at worst (measured). */
export const MAX_TOTAL_PROTOBUF_BYTES = 96 * 1024;
/**
 * Largest the document may be once every `$ref` is replaced by its target (JSON text), the size the AsyncAPI parser is given: about 2.5 s
 * there whatever the shape. Deliberately TIGHT: the gate counts every use of a `$ref` target, and a message is used about four times (in
 * `components.messages`, in its channel entry, through `operation.channel` and in `operation.messages`). Measured: 100 messages that all
 * `$ref` ONE 10 KB payload schema expand to about 3.9 MiB and are refused, 50 pass (1.95 MiB); 100 fully inline 2.9 KB payloads that also
 * share a 2.9 KB type are refused at 2.24 MiB (2.4 KB each: 1.86 MiB, they pass). Inlining does NOT help (an inlined copy counts as much
 * as a reference to it, or more): the refusal tells the user to use fewer or smaller schemas that many messages share, or to split the file.
 */
export const MAX_EXPANDED_DOCUMENT_BYTES = 2 * 1024 * 1024;
/** Most entries any one object of the document may have (the parser's cost grows with the square of that): about 0.2 s per object at the cap; real maps have far fewer. */
export const MAX_OBJECT_ENTRIES = 2_000;
/** Most entries any one list of the document may have (an `enum`, `examples`, `tags`, `required`, a list of message references ...): the mapper de-duplicates lists quadratically. */
export const MAX_LIST_ENTRIES = 5_000;
/** Most fields one entity may have. */
export const MAX_FIELDS_PER_ENTITY = 2_000;
/** Most fields the whole import may write (rows inside one transaction), an entity that is planned N times counting N times. */
export const MAX_FIELDS_PER_IMPORT = 10_000;

/** Longest entity name the importer proposes; the numeric suffix of a taken name has room below the 128-character limit. */
export const MAX_REQUESTED_NAME = 100;
/** How many names are tried (`Name`, `Name2` … `Name1000`) before the import gives up on one. */
export const MAX_NAME_ATTEMPTS = 1_000;

/** Most importer notes reported per distinct payload: a 1,000-property schema must not produce a 1,000-line report. */
export const MAX_NOTES_PER_PAYLOAD = 25;
/** Most parser warnings reported; the rest is one summary line. */
export const MAX_PARSER_WARNINGS = 100;
/** Most parser errors listed in `details.problems`: a broken 1 MiB file can have thousands. */
export const MAX_PARSER_PROBLEMS = 100;
/** Most field renames (slug collisions) reported; the rest is one summary line. */
export const MAX_FIELD_RENAME_WARNINGS = 50;
/** Longest text echoed from the document or the parser into a message, warning or problem. */
export const MAX_ECHOED_TEXT = 500;

/**
 * `value` as text of at most `max` characters, with an ellipsis when it was cut (control characters become spaces). The cut is the pure
 * layer's (`bound.ts`, which never splits a surrogate pair either); what stays here is this layer's longer default (the pure layer's is
 * 80) and the control-character flattening, which texts from the parser and from a file may need and the pure layer's helper does not do.
 */
export function boundText(value: unknown, max: number = MAX_ECHOED_TEXT): string {
  return boundForDisplay(String(value).replace(/[\u0000-\u001f\u007f]/g, " "), max);
}

const KIB = 1024;
const formatBytes = (bytes: number): string => (bytes >= KIB * KIB ? `${bytes / KIB / KIB} MiB` : `${bytes / KIB} KiB`);
const formatCount = (n: number): string => n.toLocaleString("en-US");

/** A limit refusal. The message ends with a full stop: the UI shows it followed by the suggested fix. */
const refuse = (message: string, details: object, suggestedFix: string): Result<never> =>
  err({ code: "VALIDATION_ERROR", message: /[.!?]$/.test(message) ? message : `${message}.`, details, suggestedFix });

/**
 * The size an importer would be given: a string (Protobuf source) is its length, anything else the length of its JSON text. Counted
 * only until it exceeds `limit` (the walk stops there and returns what it has counted so far), so measuring an enormous value costs
 * at most about `limit` steps, and it is iterative: no stack overflow. Exact for plain text (escapes are counted as one character).
 */
export function sizeUpTo(value: unknown, limit: number): number {
  if (typeof value === "string") return value.length;
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") total += current.length + 2;
    else if (typeof current === "number" || typeof current === "boolean" || current === null) total += String(current).length;
    else if (Array.isArray(current)) {
      total += 2 + Math.max(0, current.length - 1);
      for (const item of current) stack.push(item);
    } else if (typeof current === "object") {
      const keys = Object.keys(current);
      total += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        total += key.length + 3;
        stack.push((current as Record<string, unknown>)[key]);
      }
    }
    if (total > limit) return total;
  }
  return total;
}

/** A payload becomes at least one entity; headers only when they are a schema an importer reads (JSON Schema). */
const producesEntity = (payload: ExtractedPayload): boolean => payload.role === "payload" || payload.format === "json-schema";

/**
 * The checks that run BEFORE any importer: how many payloads, how big each is, how big they are together (reuse counted per use) and how
 * much distinct Protobuf source there is. A payload over a limit is never dropped quietly: the whole import is refused and says which
 * message and which limit.
 */
export function checkPayloadLimits(payloads: readonly ExtractedPayload[]): Result<void> {
  const count = payloads.filter(producesEntity).length;
  if (count > MAX_IMPORT_PAYLOADS) {
    return refuse(
      `This document has ${formatCount(count)} message payloads; one import reads at most ${formatCount(MAX_IMPORT_PAYLOADS)}`,
      { payloads: count, limit: MAX_IMPORT_PAYLOADS },
      "Split the document into several files and import them one by one.",
    );
  }
  let total = 0;
  let protobufTotal = 0;
  const protobufSources = new Set<string>();
  for (const payload of payloads) {
    if (payload.raw === undefined) continue;
    const protobuf = payload.format === "protobuf";
    const limit = protobuf ? MAX_PROTOBUF_PAYLOAD_BYTES : MAX_JSON_PAYLOAD_BYTES;
    const size = sizeUpTo(payload.raw, limit);
    const where = { messageKey: boundText(payload.messageKey, 100), role: payload.role, pointer: boundText(payload.sourcePointer) };
    if (size > limit) {
      return refuse(
        `The ${payload.role} of message "${where.messageKey}" is larger than ${formatBytes(limit)}, the most an import reads from one ${protobuf ? "Protobuf" : "JSON Schema or Avro"} schema`,
        { ...where, limit }, "Shorten the schema (or split it into smaller messages) and import again.",
      );
    }
    total += size;
    if (total > MAX_TOTAL_PAYLOAD_BYTES) {
      return refuse(
        `The payloads of this document add up to more than ${formatBytes(MAX_TOTAL_PAYLOAD_BYTES)} (a schema that several messages share counts once per message); it stopped at the ${payload.role} of message "${where.messageKey}"`,
        { ...where, limit: MAX_TOTAL_PAYLOAD_BYTES }, "Split the document into several files and import them one by one.",
      );
    }
    if (protobuf && typeof payload.raw === "string" && !protobufSources.has(payload.raw)) {
      protobufSources.add(payload.raw);
      protobufTotal += size;
      if (protobufTotal > MAX_TOTAL_PROTOBUF_BYTES) {
        return refuse(
          `The Protobuf schemas of this document add up to more than ${formatBytes(MAX_TOTAL_PROTOBUF_BYTES)}; it stopped at the ${payload.role} of message "${where.messageKey}"`,
          { ...where, limit: MAX_TOTAL_PROTOBUF_BYTES }, "Split the document into several files and import them one by one.",
        );
      }
    }
  }
  return ok(undefined);
}

/** Deepest nesting (references included) the expansion measure follows before it calls the document over the limit. Unreachable from the service (the parse refuses more than 256 levels first); it keeps a direct caller safe. */
const MAX_MEASURE_DEPTH = 1_000;
class OverLimit extends Error {}

/**
 * The length of the document's JSON text once every local `$ref` is replaced by its target (what the AsyncAPI parser is handed), counted
 * only until it exceeds `limit` (then `limit + 1` comes back). Nothing is expanded: a target's size is worked out once (memoised by its
 * pointer) and added for every use, so a doubling chain of references costs one step per reference, not 2^n, and measuring costs about the
 * size of the document. A reference that leads back into a target being measured (a recursive schema) is counted as the reference itself
 * and not followed, so recursion neither fails the measure nor lets it be skipped. Exact for plain documents and for references without
 * keywords beside them (checked against `resolveLocalRefs` in the unit tests); a `$ref` with siblings counts the target plus the siblings.
 */
export function expandedSizeUpTo(root: unknown, limit: number): number {
  const sizes = new Map<string, number>();
  const measuring = new Set<string>();

  const targetSize = (pointer: string, target: unknown, depth: number): number => {
    const known = sizes.get(pointer);
    if (known !== undefined) return known;
    measuring.add(pointer);
    try {
      const size = sizeOf(target, depth + 1);
      sizes.set(pointer, size);
      return size;
    } finally {
      measuring.delete(pointer);
    }
  };

  const sizeOf = (node: unknown, depth: number): number => {
    if (depth > MAX_MEASURE_DEPTH) throw new OverLimit();
    if (typeof node === "string") return node.length + 2;
    if (typeof node === "number" || typeof node === "boolean" || node === null) return String(node).length;
    if (typeof node !== "object") return 0;
    let total = 2;
    if (Array.isArray(node)) {
      total += Math.max(0, node.length - 1);
      for (const item of node) {
        total += sizeOf(item, depth + 1);
        if (total > limit) throw new OverLimit();
      }
      return total;
    }
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record);
    const segments = refTargetSegments(record);
    if (segments !== null) {
      const found = resolveLocalRef(root, localRef(...segments));
      const pointer = jsonPointer(...segments);
      if (!found.found || measuring.has(pointer)) return JSON.stringify(record).length; // dangling or recursive: the reference itself
      const target = targetSize(pointer, found.value, depth);
      const refines = typeof found.value === "object" && found.value !== null && !Array.isArray(found.value);
      if (keys.length === 1 || !refines) return target; // like the pure layer: keywords beside a ref refine an OBJECT target only
      const beside = keys.filter((key) => key !== "$ref");
      total = target + beside.length; // a comma before each member added to the target's
      for (const key of beside) {
        total += key.length + 3 + sizeOf(record[key], depth + 1);
        if (total > limit) throw new OverLimit();
      }
      return total;
    }
    total += Math.max(0, keys.length - 1);
    for (const key of keys) {
      total += key.length + 3 + sizeOf(record[key], depth + 1);
      if (total > limit) throw new OverLimit();
    }
    return total;
  };

  try {
    return Math.min(sizeOf(root, 0), limit + 1);
  } catch (e) {
    if (e instanceof OverLimit) return limit + 1;
    throw e;
  }
}

/**
 * The check that runs on the parsed document (what `parseAsyncApiSource` returns) before anything slow: no object may have more than
 * `MAX_OBJECT_ENTRIES` entries and no list more than `MAX_LIST_ENTRIES`. One walk over the document, iterative (no stack overflow, whatever
 * the depth) and allocating only for objects and lists. It names the FIRST one over its limit in document order (children are pushed in
 * reverse, so the walk is pre-order: `{ a: 2001 keys, b: 2001 keys }` names `/a`, a parent before its children; "document order" is the
 * order JavaScript keeps, which is exact only up to integer-like keys: those come first, in ascending order, so `{ b, "2", "1" }` names
 * `/1`, not `/b`) by its pointer, built
 * without spreading the path (a path of 150,000 segments is fine) and bounded in the message. Only the entries written in the document
 * count: a `$ref` is not expanded here (`checkExpandedSize` measures that).
 */
export function checkEntryCounts(raw: unknown): Result<void> {
  interface Frame { value: object; key: string | number; parent: Frame | null }
  const isContainer = (value: unknown): value is object => typeof value === "object" && value !== null;
  const pointerOf = (frame: Frame): string => {
    const segments: Array<string | number> = [];
    for (let f: Frame | null = frame; f !== null && f.parent !== null; f = f.parent) segments.push(f.key);
    let pointer = "";
    for (let i = segments.length - 1; i >= 0; i -= 1) pointer += `/${escapePointerSegment(String(segments[i]))}`;
    return boundText(pointer, 200);
  };
  const stack: Frame[] = isContainer(raw) ? [{ value: raw, key: "", parent: null }] : [];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (Array.isArray(frame.value)) {
      const items: unknown[] = frame.value;
      if (items.length > MAX_LIST_ENTRIES) {
        const pointer = pointerOf(frame);
        return refuse(
          `A list in the document (${pointer === "" ? "the document itself" : `at "${pointer}"`}) has more than ${formatCount(MAX_LIST_ENTRIES)} entries (limit ${formatCount(MAX_LIST_ENTRIES)}): shorten it or remove unused entries.`,
          { kind: "list", pointer, entries: items.length, limit: MAX_LIST_ENTRIES }, "Real AsyncAPI documents have far shorter lists; check for a generated or repeated section.",
        );
      }
      for (let i = items.length - 1; i >= 0; i -= 1) if (isContainer(items[i])) stack.push({ value: items[i] as object, key: i, parent: frame });
      continue;
    }
    const record = frame.value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > MAX_OBJECT_ENTRIES) {
      const pointer = pointerOf(frame);
      return refuse(
        `An object in the document (${pointer === "" ? "the document itself" : `at "${pointer}"`}) has more than ${formatCount(MAX_OBJECT_ENTRIES)} entries (limit ${formatCount(MAX_OBJECT_ENTRIES)}): split it or remove unused entries.`,
        { kind: "object", pointer, entries: keys.length, limit: MAX_OBJECT_ENTRIES }, "Real AsyncAPI documents have far fewer entries in one object; check for a generated or repeated section.",
      );
    }
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const child = record[keys[i]];
      if (isContainer(child)) stack.push({ value: child, key: keys[i], parent: frame });
    }
  }
  return ok(undefined);
}

/** The check that runs right after `checkEntryCounts`, before anything slow: a document that is too big once its references are resolved is refused (nothing is written at all: the tenant's built-in library traits are installed only after the AsyncAPI parser has accepted the document). */
export function checkExpandedSize(raw: unknown): Result<void> {
  if (expandedSizeUpTo(raw, MAX_EXPANDED_DOCUMENT_BYTES) <= MAX_EXPANDED_DOCUMENT_BYTES) return ok(undefined);
  return refuse(
    `The document is too large once its references are resolved (limit ${formatBytes(MAX_EXPANDED_DOCUMENT_BYTES)}): every place that refers to a shared definition counts a full copy of it`,
    { limit: MAX_EXPANDED_DOCUMENT_BYTES }, "Use fewer or smaller schemas that many messages share, or split the document into smaller files (a message counts about four times: in its component, its channel entry and two operation lists).",
  );
}

/** The part of a planned payload the plan limits read (structural, so this module needs nothing from the planner). */
export interface PlanShape { pinKey: string; entities: ReadonlyArray<{ requestedName: string; fields: readonly unknown[] }> }

/** The checks that run after planning and before the first write: entities, fields per entity and fields per import (reuse counted per use). */
export function checkPlanLimits(plans: readonly PlanShape[]): Result<void> {
  const entities = plans.reduce((sum, plan) => sum + plan.entities.length, 0);
  if (entities > MAX_IMPORT_ENTITIES) {
    return refuse(
      `This document would create ${entities} entities; one import creates at most ${MAX_IMPORT_ENTITIES}`,
      { entities, limit: MAX_IMPORT_ENTITIES }, "Split the document into several files and import them one by one.",
    );
  }
  let fields = 0;
  for (const plan of plans) {
    for (const entity of plan.entities) {
      if (entity.fields.length > MAX_FIELDS_PER_ENTITY) {
        return refuse(
          `The entity "${boundText(entity.requestedName, 100)}" (from ${boundText(plan.pinKey, 100)}) would have ${formatCount(entity.fields.length)} fields; one entity may have at most ${formatCount(MAX_FIELDS_PER_ENTITY)}`,
          { entity: boundText(entity.requestedName, 100), pin: boundText(plan.pinKey, 100), fields: entity.fields.length, limit: MAX_FIELDS_PER_ENTITY },
          "Split the schema into smaller ones and import again.",
        );
      }
      fields += entity.fields.length;
      if (fields > MAX_FIELDS_PER_IMPORT) {
        return refuse(
          `This document would create more than ${formatCount(MAX_FIELDS_PER_IMPORT)} fields (a schema that several messages share counts once per message); it stopped at the entity "${boundText(entity.requestedName, 100)}"`,
          { entity: boundText(entity.requestedName, 100), pin: boundText(plan.pinKey, 100), limit: MAX_FIELDS_PER_IMPORT },
          "Split the document into several files and import them one by one.",
        );
      }
    }
  }
  return ok(undefined);
}
