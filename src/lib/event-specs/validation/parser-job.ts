// src/lib/event-specs/validation/parser-job.ts
// The wire format between the parser runner (`parser-runner.ts`, in the server) and the parser worker (`parser-worker.ts`, a child process): plain
// JSON, no classes, nothing that needs the AsyncAPI parser to read. Imported by both sides (types and two constants only: it holds no logic).
import type { Result } from "@/types/result";
import type { RawAsyncApi3 } from "@/lib/events/import/types";
import type { Diagnostic } from "../types";

/**
 * The jobs a worker runs (everything that can block the event loop for seconds on a hostile document):
 * - `validate`: the emit-time check of `AsyncApiParserValidator` (`text` is the document as JSON): the parser, the 2020-12 schemas it cannot read
 *   and the Kafka key schemas;
 * - `importValidate`: the importer's verdict of the parser on a document read from a file (`text` is the document as JSON);
 * - `parseSource`: `parseAsyncApiSource` (`text` is the YAML or JSON file).
 */
export type ParserJobKind = "validate" | "importValidate" | "parseSource";
export interface WireJob { kind: ParserJobKind; text: string }

/** What the parser reports about a document, reduced to what the callers read (the source ranges are dropped: they only make the message larger). `severity`: 0 error, 1 warning, 2 information, 3 hint. */
export interface RawParserDiagnostic { code: string | number; message: string; path: Array<string | number>; severity: number }

/** `parser`: the parser's own diagnostics; `extra`: ours (JSON Schema 2020-12 payloads not validated, Kafka key schemas) found by the same job. */
export interface ValidateJobResult { parser: RawParserDiagnostic[]; extra: Diagnostic[] }
export interface ImportValidateJobResult { diagnostics: RawParserDiagnostic[] }
/** What the pure function answers, as it is (its own error codes: `PARSE_ERROR`, `TOO_LARGE`, `UNSUPPORTED_VERSION`). */
export type ParseSourceJobResult = Result<RawAsyncApi3>;

export interface JobResults {
  validate: ValidateJobResult;
  importValidate: ImportValidateJobResult;
  parseSource: ParseSourceJobResult;
}
export type JobResult = JobResults[ParserJobKind];

/** Parent to worker. */
export type ToWorker = { type: "job"; id: number; job: WireJob };
/**
 * Worker to parent. `result.body` is the JSON of the answer (the worker serialises it once to measure it). `failed`: the job threw
 * (`exception`, `text` is for the server log only) or its answer is over the message limit (`too-large`).
 */
export type FromWorker =
  | { type: "ready"; pid: number }
  | { type: "result"; id: number; body: string }
  | { type: "failed"; id: number; reason: "exception" | "too-large"; text: string };

/** The most one message may carry, each way (bytes of its JSON). A document the parser may read is far smaller (the importer caps the file at 1 MiB). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** `MAX_MESSAGE_BYTES`, or the value of `ASYNCAPI_PARSER_MAX_MESSAGE_BYTES` (a positive number; for tests). Read when called: both sides see the same environment. */
export function maxMessageBytes(): number {
  const raw = Number(process.env.ASYNCAPI_PARSER_MAX_MESSAGE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MAX_MESSAGE_BYTES;
}
