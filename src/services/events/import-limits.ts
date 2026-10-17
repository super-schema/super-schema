// src/services/events/import-limits.ts
// Every bound of the AsyncAPI import in ONE place. The file is capped at 1 MiB (`checkImportSize`) and the YAML / `$ref` expansion by the
// pure layer (`src/lib/events/import/limits.ts`); these are the bounds on what the import then DOES with the payload schemas, all checked
// BEFORE the first write, so a document over any of them creates nothing and says which limit it hit.
//
// Why each exists (measured on the real importers): the JSON Schema and Avro importers are linear (a 256 KiB schema: 8 ms), the Protobuf
// importer is quadratic in the fields of ONE message (5,000 fields in one message: 1.3 s, 20,000: 23 s) and runs synchronously, so nothing can
// interrupt it: the only protection is to not hand it too much. A `$ref` that many messages share is inlined once per message, so reuse is
// counted per use. Fields are rows inside one transaction that holds the tenant's name lock (it blocks every name-writing operation of the tenant).
import type { ExtractedPayload } from "@/lib/events/import";
import { err, ok, type Result } from "@/types/result";

/** Most entities one import may create (payloads, headers and their definitions together). */
export const MAX_IMPORT_ENTITIES = 500;
/** Most message payloads (and importable headers) one import may read: one entity each at least, so over this the entity cap is certain. */
export const MAX_IMPORT_PAYLOADS = 500;
/** Largest JSON Schema or Avro payload an importer is given (serialized JSON length, `$ref`s inlined). */
export const MAX_JSON_PAYLOAD_BYTES = 256 * 1024;
/** Largest Protobuf payload an importer is given (source length). */
export const MAX_PROTOBUF_PAYLOAD_BYTES = 128 * 1024;
/** Largest total of all payloads handed to importers, a schema used by N messages counting N times. */
export const MAX_TOTAL_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** Largest total of DISTINCT Protobuf sources (each is parsed once, and parsing is quadratic): two maximal sources are about 3 s of blocked server. */
export const MAX_TOTAL_PROTOBUF_BYTES = 256 * 1024;
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
