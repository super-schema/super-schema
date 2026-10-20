import { ok, type Result, type ServiceError } from "@/types/result";
import type { Diagnostic, DiagnosticSeverity as EventSpecSeverity } from "../types";
import { diagnostic, normalizeDiagnostics } from "../diagnostics";
import { escapePointerSegment, jsonPointer } from "../json-pointer";
import { isParserUnsafeKey } from "../own-property";
import { validatorFailure, type EventSpecValidator } from "../validator";
import { BUSY_TEXT, runParserJob, timeoutOf, tooComplexLead, TOO_COMPLEX_FIX } from "./parser-runner";

/**
 * Story 18.5 — `@asyncapi/parser` (v3) backed `EventSpecValidator`.
 *
 * Server-only and heavy (Spectral, Ajv, avsc, protobufjs): import it from server code only, never from client components, and it is
 * intentionally NOT re-exported from the `event-specs` barrel. Opt in per adapter:
 *
 *   new AsyncApi3Adapter({ validators: [new AsyncApiParserValidator()] })
 *
 * The parser itself does NOT run in this process: it is synchronous Spectral, and a document that passes every cap can block a thread for about
 * 10 s, so `validate()` hands the document to a warm child process with a hard timeout (`parser-runner.ts`; the parser side is `parser-core.ts`).
 * What needs no parser stays here, in front of and behind the job: the non-local `$ref` scan, the guard for keys the parser cannot read, the
 * mapping of the parser's diagnostics to ours and the sanitiser of a parser crash. A document cut at the time limit, or sent while the validator
 * is busy, comes back as an ERROR diagnostic (`PARSER_TIMEOUT`, `PARSER_BUSY`), so it cannot be published.
 *
 * Security (spec §10, SSRF): remote `$ref` resolution is OFF. The parser's default `file` / `http` / `https` resolvers are always installed and a
 * throwing custom resolver does not stop them (the parser falls through to the next one), so `createAsyncApiParser` (`parser-core.ts`) gives each
 * scheme an `order: 1` resolver that answers with a document holding a dangling local `$ref`: any non-local `$ref` fails loudly (`invalid-ref`)
 * and nothing is fetched or read. On top of that, `validate()` rejects non-local `$ref`s up front (`REMOTE_REF`) without invoking the parser at all.
 */

/** Parser severity (`DiagnosticSeverity` of `@stoplight/types`, as the parser reports it; plain numbers, so this module needs no parser): 0 error, 1 warning, 2 information, 3 hint. */
function mapSeverity(severity: number): EventSpecSeverity {
  if (severity === 0) return "error";
  if (severity === 1) return "warning";
  return "info";
}

/** What of a parser diagnostic is read here: the parser's own `Diagnostic` has all of it, and so has `RawParserDiagnostic`, the worker's reduction of it. */
export interface ParserDiagnosticLike { code: string | number; message: string; path?: ReadonlyArray<string | number>; severity: number }

/** Parser diagnostic → `Diagnostic`; the RFC 6901 pointer is built from the diagnostic's `path`. */
export function mapParserDiagnostic(d: ParserDiagnosticLike): Diagnostic {
  return diagnostic(mapSeverity(d.severity), String(d.code), d.message, jsonPointer(...(d.path ?? [])));
}

/** What a user is told when the parser itself fails on a document: the exception (its stack, server paths) goes to the log, never to the browser. */
const PARSER_CRASHED_MESSAGE =
  "The AsyncAPI parser could not process this document. Nothing is wrong that you can fix here: try again, and contact an administrator if it keeps happening.";

/**
 * What a crash TEXT looks like: a real V8 stack-frame line (`\n    at Foo.bar (/srv/app/file.js:35:33)` or `\n    at /srv/app/file.js:35:33`), or an absolute
 * path to a file with its position (`/Users/x/app/file.js:35:33`, `C:\\app\\file.js:35`). Plain words such as `node_modules`, `home` or `Users` in a
 * pointer or a name (`#/channels/home/messages/nope`, `#/components/schemas/node_modules`) are NOT a crash: the parser's own diagnostics
 * about them are ordinary ones and must reach the user as they are.
 */
const STACK_FRAME = /\n\s+at (?:\S+ \(.+:\d+:\d+\)|.+:\d+:\d+)/;
const FILE_POSITION = /(?:^|[\s(])(?:\/(?:[^\s/:()]+\/)*[^\s/:()]+|[A-Za-z]:\\(?:[^\s\\:()]+\\)*[^\s\\:()]+)\.[A-Za-z][A-Za-z0-9]{0,7}:\d+(?::\d+)?/;

/**
 * True for a parser diagnostic that reports a CRASH of the parser: its code is `uncaught-error` (the parser catches its own exceptions and
 * returns them so, with the exception's name, message and stack and absolute server paths), or its message holds a real stack-frame line, or an
 * absolute path with a file position (see `STACK_FRAME`, `FILE_POSITION`). Such a text is never shown to a user. Takes the parser's own
 * diagnostics as well as ours.
 */
export function isParserCrashDiagnostic(d: { code: string | number; message: string }): boolean {
  return String(d.code) === "uncaught-error" || STACK_FRAME.test(d.message) || FILE_POSITION.test(d.message);
}

/**
 * The diagnostics with every parser crash replaced by ONE generic error (`ASYNCAPI_PARSER_CRASHED`, no pointer). The full text of each
 * crash is logged server-side (once each), so an administrator can find the cause; nothing returned from here holds a stack or a path.
 */
export function sanitizeParserDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const kept: Diagnostic[] = [];
  const crashes = new Set<string>();
  for (const d of list) {
    if (isParserCrashDiagnostic(d)) crashes.add(d.message);
    else kept.push(d);
  }
  if (crashes.size === 0) return list;
  for (const text of crashes) console.error("[asyncapi-parser] the parser crashed on an emitted document:", text);
  kept.push(diagnostic("error", "ASYNCAPI_PARSER_CRASHED", PARSER_CRASHED_MESSAGE, ""));
  return kept;
}

/** RFC 6901 pointer of `segments`, built without spreading them (a document can be deeper than a call may have arguments). */
const pointerOfSegments = (segments: ReadonlyArray<string | number>): string => segments.map((segment) => `/${escapePointerSegment(String(segment))}`).join("");

/** The most `PARSER_UNSAFE_KEY` errors one document reports (a document that has one such key usually has many copies of it). */
const MAX_UNSAFE_KEY_DIAGNOSTICS = 20;
/** The guard looks at no more than this many keys and array items; a larger document is left to the parser. */
const MAX_GUARD_VALUES = 2_000_000;

const UNSAFE_KEY_REASON = "is a built-in JavaScript name that AsyncAPI tools cannot read, so this document cannot be published with it.";

/**
 * What to tell the user about the unsafe `key` found in the object at `parents`:
 * - a key in a `properties` map of a message PAYLOAD (`/components/messages/<message>/payload/schema/…/properties/<key>`) is a FIELD of an
 *   entity: name it, the message, and where to fix it;
 * - a key in the `definitions` / `$defs` map of a payload schema, or a component schema name (`/components/schemas/<key>`), is the NAME of an
 *   entity (or model) the payload refers to;
 * - any other key is named as it is (the diagnostic's pointer says where).
 */
function unsafeKeyMessage(parents: ReadonlyArray<string | number>, key: string): string {
  const inPayload = parents[0] === "components" && parents[1] === "messages" && parents[3] === "payload";
  const last = parents[parents.length - 1];
  if (inPayload && last === "properties") return `The field "${key}" in the payload of the message "${parents[2]}" ${UNSAFE_KEY_REASON} Rename the field in its entity.`;
  const isComponentSchema = parents.length === 2 && parents[0] === "components" && parents[1] === "schemas";
  if ((inPayload && (last === "definitions" || last === "$defs")) || isComponentSchema) return `The name "${key}" ${UNSAFE_KEY_REASON} Rename the entity (or model).`;
  return `The key "${key}" ${UNSAFE_KEY_REASON} Rename it.`;
}

/**
 * The choke point for keys the AsyncAPI parser cannot read (`PARSER_UNSAFE_KEYS`): every own key of every object of the finished
 * document, objects inside arrays included, is checked, wherever it sits (a channel, a message, a JSON Schema property that came from an
 * entity field, a binding, an `x-` extension, a server variable ...). Each one is a `PARSER_UNSAFE_KEY` error at the key's own pointer, so
 * the document is refused with a clear message instead of reaching the parser, which would crash on it.
 *
 * Iterative (a document can be deep and large), bounded (`MAX_GUARD_VALUES`, `MAX_UNSAFE_KEY_DIAGNOSTICS`), never throws, never follows a
 * `$ref`, and reads own enumerable KEYS only (`Object.keys`), so a VALUE equal to "hasOwnProperty" is not a finding.
 */
export function findParserUnsafeKeys(document: unknown): Diagnostic[] {
  type Frame = { value: object; parent: Frame | null; key: string | number };
  const found: Diagnostic[] = [];
  if (typeof document !== "object" || document === null) return found;
  const stack: Frame[] = [{ value: document, parent: null, key: "" }];
  const keysAbove = (frame: Frame): Array<string | number> => {
    const parts: Array<string | number> = [];
    for (let f: Frame | null = frame; f !== null && f.parent !== null; f = f.parent) parts.push(f.key);
    return parts.reverse();
  };
  let values = 0;
  try {
    while (stack.length > 0 && found.length < MAX_UNSAFE_KEY_DIAGNOSTICS) {
      const frame = stack.pop() as Frame;
      const node = frame.value;
      if (Array.isArray(node)) {
        values += node.length;
        if (values > MAX_GUARD_VALUES) break;
        // document order: the stack is last in, first out, so the children go on in reverse
        for (let i = node.length - 1; i >= 0; i -= 1) {
          const item: unknown = node[i];
          if (typeof item === "object" && item !== null) stack.push({ value: item, parent: frame, key: i });
        }
        continue;
      }
      const keys = Object.keys(node);
      values += keys.length;
      if (values > MAX_GUARD_VALUES) break;
      if (keys.some(isParserUnsafeKey)) {
        const parents = keysAbove(frame);
        for (const key of keys) {
          if (found.length >= MAX_UNSAFE_KEY_DIAGNOSTICS) break;
          if (isParserUnsafeKey(key)) found.push(diagnostic("error", "PARSER_UNSAFE_KEY", unsafeKeyMessage(parents, key), pointerOfSegments([...parents, key])));
        }
      }
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const child = (node as Record<string, unknown>)[keys[i]];
        if (typeof child === "object" && child !== null) stack.push({ value: child, parent: frame, key: keys[i] });
      }
    }
  } catch {
    // Not reachable for a document `JSON.stringify` can write; what was found stands, and the parser is the next line of defence.
  }
  return found;
}

/**
 * Every non-local `$ref` in the document (any `$ref` key counts, as in the structural validator). Iterative (a document can be deeper than
 * the call stack allows: `validate` must never throw) and bounded like the unsafe-key guard (`MAX_GUARD_VALUES`).
 */
function findRemoteRefs(root: unknown, out: Diagnostic[]): void {
  type Frame = { value: unknown; parent: Frame | null; key: string | number };
  const stack: Frame[] = [{ value: root, parent: null, key: "" }];
  const pathOf = (frame: Frame | null): Array<string | number> => {
    const parts: Array<string | number> = [];
    for (let f = frame; f !== null && f.parent !== null; f = f.parent) parts.push(f.key);
    return parts.reverse();
  };
  let values = 0;
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const node = frame.value;
    if (typeof node !== "object" || node === null) continue;
    const entries: Array<[string | number, unknown]> = Array.isArray(node) ? node.map((item, i): [number, unknown] => [i, item]) : Object.entries(node);
    values += entries.length;
    if (values > MAX_GUARD_VALUES) return;
    // document order: the stack is last in, first out, so the children go on in reverse
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const [key, value] = entries[i];
      if (key === "$ref" && typeof value === "string") continue;
      stack.push({ value, parent: frame, key });
    }
    const ref = Array.isArray(node) ? undefined : (node as Record<string, unknown>)["$ref"];
    if (typeof ref === "string" && !ref.startsWith("#")) {
      out.push(diagnostic("error", "REMOTE_REF", `Only local references are allowed, got "${ref}"`, pointerOfSegments(pathOf(frame))));
    }
  }
}

/** A failure of the runner as the validator reports it: its two limits are error diagnostics (the document cannot be published), anything else is an infrastructure failure (logged, generic). */
function runnerFailure(error: ServiceError): Result<Diagnostic[]> {
  switch (error.code) {
    case "PARSER_TIMEOUT":
      return ok([diagnostic("error", "PARSER_TIMEOUT", `${tooComplexLead(timeoutOf(error))} ${TOO_COMPLEX_FIX}`, "")]);
    case "PARSER_BUSY":
      return ok([diagnostic("error", "PARSER_BUSY", BUSY_TEXT, "")]);
    case "PARSER_MESSAGE_TOO_LARGE":
      return ok([diagnostic("error", "PARSER_TOO_LARGE", `This document is too large, or has too many problems, to validate here. ${TOO_COMPLEX_FIX}`, "")]);
    default:
      // The runner logged the cause (exit code, stack, path of the worker file); only its code goes along here.
      return validatorFailure("ASYNCAPI_PARSER_FAILED", "@asyncapi/parser", error.code);
  }
}

export class AsyncApiParserValidator implements EventSpecValidator {
  readonly name = "asyncapi-parser";

  /**
   * Parse (not just validate) so the registered Avro / Protobuf schema parsers also run over every payload. Document problems come back as
   * diagnostics; only a failure of the parser itself is an `err` Result. JSON Schema 2020-12 schemas, which the parser cannot validate, are
   * reported as `PAYLOAD_NOT_VALIDATED` warnings; Kafka key schemas (which the parser never looks inside) are validated too
   * (`KAFKA_KEY_SCHEMA_*` errors): all in one worker job (`parser-core.ts`), with a time limit (`PARSER_TIMEOUT`, `PARSER_BUSY`).
   */
  async validate(document: object): Promise<Result<Diagnostic[]>> {
    const remote: Diagnostic[] = [];
    findRemoteRefs(document, remote);
    if (remote.length > 0) return ok(normalizeDiagnostics(remote));
    // A key the parser cannot read (`hasOwnProperty`) would crash it: refuse the document here, with the key and its pointer.
    const unsafe = findParserUnsafeKeys(document);
    if (unsafe.length > 0) return ok(normalizeDiagnostics(unsafe));

    try {
      const job = await runParserJob({ kind: "validate", document });
      if (!job.success) return runnerFailure(job.error);
      // A crash inside the parser comes back as a diagnostic with the exception's stack and server paths: logged, then replaced.
      const parsed = sanitizeParserDiagnostics(job.data.parser.map(mapParserDiagnostic));
      return ok(normalizeDiagnostics([...parsed, ...job.data.extra]));
    } catch (e) {
      // Not reachable (the runner never throws); an unexpected exception is still logged, never returned.
      return validatorFailure("ASYNCAPI_PARSER_FAILED", "@asyncapi/parser", e);
    }
  }
}
