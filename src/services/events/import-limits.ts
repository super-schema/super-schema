// src/services/events/import-limits.ts
// Every bound of the AsyncAPI import in ONE place. The file is capped at 1 MiB (`checkImportSize`) and the YAML / `$ref` expansion by the
// pure layer (`src/lib/events/import/limits.ts`); these are the bounds on what the import then DOES with the payload schemas, all checked
// BEFORE the first write, so a document over any of them creates nothing and says which limit it hit.
//
// Why each exists (measured on the real code): the JSON Schema and Avro importers are linear (a 256 KiB schema: 8 ms); the Protobuf importer
// is quadratic in the fields of ONE message and runs synchronously, so nothing can interrupt it and the only protection is to not hand it too
// much (worst compact case, enum-typed fields: 128 KiB 6.1 s, 64 KiB 1.45 s, 32 KiB 0.36 s, 16 KiB 0.1 s). The AsyncAPI parser (Spectral) is
// not interruptible either and costs roughly 0.2 - 0.6 s per MB of its input AFTER every `$ref` is replaced by its target (3.9 MB of
// expanded JSON: 2.3 s), so a 2 KiB document of references to a shared definition can be tens of MB for it: that expansion is measured
// before it runs (`checkExpandedSize`, a millisecond or less). A `$ref` that
// many messages share is inlined once per message, so reuse is counted per use. Fields are rows inside one transaction that holds the
// tenant's name lock (it blocks every name-writing operation of the tenant).
import { refTargetSegments } from "@/lib/events/import/refs";
import type { ExtractedPayload } from "@/lib/events/import";
import { jsonPointer, localRef, resolveLocalRef } from "@/lib/event-specs/json-pointer";
import { err, ok, type Result } from "@/types/result";

/** Most entities one import may create (payloads, headers and their definitions together). */
export const MAX_IMPORT_ENTITIES = 500;
/** Most message payloads (and importable headers) one import may read: one entity each at least, so over this the entity cap is certain. */
export const MAX_IMPORT_PAYLOADS = 500;
/** Largest JSON Schema or Avro payload an importer is given (serialized JSON length, `$ref`s inlined). */
export const MAX_JSON_PAYLOAD_BYTES = 256 * 1024;
/** Largest Protobuf payload an importer is given (source length). 64 KiB is about 1.1 s worst case (measured, 4,800 compact enum-typed fields) and still holds a fully legitimate 2,000-field message. */
export const MAX_PROTOBUF_PAYLOAD_BYTES = 64 * 1024;
/** Largest total of all payloads handed to importers, a schema used by N messages counting N times. */
export const MAX_TOTAL_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** Largest total of DISTINCT Protobuf sources (each is parsed once, and parsing is quadratic): a 64 KiB and a 32 KiB source are about 1.4 s of blocked server at worst (measured). */
export const MAX_TOTAL_PROTOBUF_BYTES = 96 * 1024;
/** Largest the document may be once every `$ref` is replaced by its target (JSON text), the size the AsyncAPI parser is given. */
export const MAX_EXPANDED_DOCUMENT_BYTES = 4 * 1024 * 1024;
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

/** `value` as text of at most `max` characters, with an ellipsis when it was cut (control characters become spaces). */
export function boundText(value: unknown, max: number = MAX_ECHOED_TEXT): string {
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

const KIB = 1024;
const formatBytes = (bytes: number): string => (bytes >= KIB * KIB ? `${bytes / KIB / KIB} MiB` : `${bytes / KIB} KiB`);
const formatCount = (n: number): string => n.toLocaleString("en-US");

const refuse = (message: string, details: object, suggestedFix: string): Result<never> =>
  err({ code: "VALIDATION_ERROR", message, details, suggestedFix });

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

/** Deepest nesting (references included) the expansion measure follows before it calls the document over the limit; the pure layer refuses far less. */
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

/** The check that runs before the AsyncAPI parser: a document that is too big once its references are resolved is refused (nothing is created). */
export function checkExpandedSize(raw: unknown): Result<void> {
  if (expandedSizeUpTo(raw, MAX_EXPANDED_DOCUMENT_BYTES) <= MAX_EXPANDED_DOCUMENT_BYTES) return ok(undefined);
  return refuse(
    `The document is too large once its references are resolved (limit ${formatBytes(MAX_EXPANDED_DOCUMENT_BYTES)}): every place that refers to a shared definition counts a full copy of it`,
    { limit: MAX_EXPANDED_DOCUMENT_BYTES }, "Reduce how often large definitions are referenced (or how deeply they refer to each other), or split the document.",
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
