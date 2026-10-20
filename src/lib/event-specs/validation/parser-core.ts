// src/lib/event-specs/validation/parser-core.ts
// What a parser worker does with a job (`parser-job.ts`): the part of `AsyncApiParserValidator` and of the AsyncAPI importer that needs the
// `@asyncapi/parser` package, the Avro / Protobuf schema parsers, or reads a document that may be hostile. It runs in the worker process
// (`parser-worker.ts`, bundled with esbuild into `worker-dist/`), and in the server process only when `ASYNCAPI_PARSER_IN_PROCESS=1` (see
// `parser-runner.ts`). Never import it from code that runs in the server by default: it loads the parser (Spectral, Ajv, avsc, protobufjs).
import { Parser } from "@asyncapi/parser";
import type { Diagnostic as ParserDiagnostic } from "@asyncapi/parser";
import { AvroSchemaParser } from "@asyncapi/avro-schema-parser";
import { ProtoBuffSchemaParser } from "@asyncapi/protobuf-schema-parser";
import { parseAsyncApiSource } from "@/lib/events/import/source";
import type { RawAsyncApi3 } from "@/lib/events/import/types";
import type { Diagnostic } from "../types";
import { diagnostic } from "../diagnostics";
import { jsonPointer } from "../json-pointer";
import type { ImportValidateJobResult, JobResult, ParseSourceJobResult, RawParserDiagnostic, ValidateJobResult, WireJob } from "./parser-job";

/** Answer served for every non-local `$ref`: resolves to a dangling pointer → `invalid-ref` error. */
const REMOTE_REF_BLOCKED_DOCUMENT = JSON.stringify({ $ref: "#/remote-references-are-disabled" });

const BLOCKED_SCHEMES = ["file", "http", "https"] as const;

/**
 * A parser with the Avro and Protobuf schema parsers registered and remote `$ref` resolution disabled (spec §10, SSRF): the parser's default
 * `file` / `http` / `https` resolvers are always installed and a throwing custom resolver does not stop them (the parser falls through to the
 * next one), so each scheme gets an `order: 1` resolver that answers with a document holding a dangling local `$ref`. Any non-local `$ref`
 * therefore fails loudly (`invalid-ref`) and nothing is fetched or read. Exported for tests and for callers that need the parsed document
 * model; the jobs use one lazily-created instance.
 */
export function createAsyncApiParser(): Parser {
  return new Parser({
    schemaParsers: [AvroSchemaParser(), ProtoBuffSchemaParser()],
    __unstable: {
      resolver: {
        cache: false,
        resolvers: BLOCKED_SCHEMES.map((schema) => ({
          schema,
          order: 1,
          canRead: true,
          read: () => REMOTE_REF_BLOCKED_DOCUMENT,
        })),
      },
    },
  });
}

/**
 * JSON Schema 2020-12 payloads/headers (`schemaFormat: application/schema+json;version=2020-12`).
 * `@asyncapi/parser` has no schema parser for this format and stays silent about it, so a
 * 2020-12 schema would look "clean" without ever having been looked at. Validating it needs a
 * 2020-12-capable Ajv (`ajv@8`, `ajv/dist/2020`) — the project only resolves `ajv@6` (undeclared,
 * transitive) and `ajv@8` exists solely nested under other packages, so it cannot be imported
 * cleanly without a package.json change. Until `ajv@^8` is a declared dependency, say so
 * explicitly with a warning instead of reporting a silent pass.
 */
const UNVALIDATED_SCHEMA_FORMAT = /^application\/schema\+(json|yaml);version=2020-12$/i;

function findUnvalidatedSchemas(node: unknown, path: Array<string | number>, out: Diagnostic[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => findUnvalidatedSchemas(item, [...path, i], out));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (
    typeof record.schemaFormat === "string" &&
    UNVALIDATED_SCHEMA_FORMAT.test(record.schemaFormat.trim()) &&
    "schema" in record
  ) {
    out.push(
      diagnostic(
        "warning",
        "PAYLOAD_NOT_VALIDATED",
        `Schema format "${record.schemaFormat}" has no schema parser in @asyncapi/parser; this JSON Schema 2020-12 schema was NOT validated`,
        jsonPointer(...path),
      ),
    );
    return;
  }
  for (const [key, value] of Object.entries(record)) findUnvalidatedSchemas(value, [...path, key], out);
}

/**
 * Kafka message binding `key` (spec §7.2 step 3). The assembler emits an Avro key as a Multi Format Schema Object
 * `{ schemaFormat, schema }`; the binding's own JSON Schema check cannot look inside it, and `@asyncapi/parser`'s Avro
 * schema parser only validates payloads / headers. Validate the key schema here, with the same bundled Avro parser, so a
 * malformed key surfaces as an error instead of passing silently. Plain JSON Schema keys (no `schemaFormat`) are already
 * validated by the binding's JSON Schema; a 2020-12 / draft-07 tagged key is accepted (2020-12 gets the generic
 * `PAYLOAD_NOT_VALIDATED` warning); any other `schemaFormat` is not a supported key format.
 */
const avroKeyParser = AvroSchemaParser();
const AVRO_KEY_FORMATS = new Set(avroKeyParser.getMimeTypes().map((m) => m.toLowerCase()));
const JSON_SCHEMA_KEY_FORMAT = /^application\/schema\+(json|yaml);version=(draft-07|2020-12)$/i;

const normalizeFormat = (format: string): string => format.replace(/\s+/g, "").toLowerCase();

async function validateKafkaKey(key: unknown, path: Array<string | number>, out: Diagnostic[]): Promise<void> {
  if (typeof key !== "object" || key === null || Array.isArray(key)) return;
  const record = key as Record<string, unknown>;
  if (!("schemaFormat" in record)) return;
  const pointer = jsonPointer(...path);
  const format = record.schemaFormat;
  if (typeof format !== "string" || !(AVRO_KEY_FORMATS.has(normalizeFormat(format)) || JSON_SCHEMA_KEY_FORMAT.test(format.trim()))) {
    out.push(
      diagnostic(
        "error",
        "KAFKA_KEY_SCHEMA_FORMAT_UNSUPPORTED",
        `Kafka key schemaFormat ${JSON.stringify(format)} is not supported; use Avro or JSON Schema`,
        pointer,
      ),
    );
    return;
  }
  if (!AVRO_KEY_FORMATS.has(normalizeFormat(format))) return;
  // `validate` only reads `data` and `path` (it runs `avsc.Type.forSchema`); the rest of the input is parser plumbing.
  const input = { data: record.schema, path: [...path, "schema"] } as unknown as Parameters<typeof avroKeyParser.validate>[0];
  const problems = (await avroKeyParser.validate(input)) ?? [];
  for (const problem of problems) {
    out.push(diagnostic("error", "KAFKA_KEY_SCHEMA_INVALID", `Kafka key Avro schema is invalid: ${problem.message}`, pointer));
  }
}

/** Every `…/bindings/kafka/key` in the document (components, traits, channel / operation bindings). */
async function validateKafkaKeys(node: unknown, path: Array<string | number>, out: Diagnostic[]): Promise<void> {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) await validateKafkaKeys(item, [...path, i], out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "bindings" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const kafka = (value as Record<string, unknown>).kafka;
      if (typeof kafka === "object" && kafka !== null && !Array.isArray(kafka) && "key" in kafka) {
        await validateKafkaKey((kafka as Record<string, unknown>).key, [...path, "bindings", "kafka", "key"], out);
      }
    }
    await validateKafkaKeys(value, [...path, key], out);
  }
}

let parser: Parser | undefined;
const sharedParser = (): Parser => (parser ??= createAsyncApiParser());

/** Creates the parser now (about 250 ms): a worker does it before it says it is ready, so the first job does not pay for it. */
export function warmUp(): void {
  sharedParser();
}

/** The parser's diagnostics without their source ranges (`RawParserDiagnostic`). */
const compact = (list: ParserDiagnostic[]): RawParserDiagnostic[] =>
  list.map((d) => ({ code: d.code, message: d.message, path: d.path ?? [], severity: d.severity }));

/**
 * `AsyncApiParserValidator.validate` after its guards: the document (as JSON text) goes through `parser.parse`, then the 2020-12 schemas the
 * parser cannot read and the Kafka key schemas are looked at. The parent maps and sanitises the parser's diagnostics.
 */
async function validate(text: string): Promise<ValidateJobResult> {
  const output = await sharedParser().parse(text);
  const extra: Diagnostic[] = [];
  const document: unknown = JSON.parse(text);
  findUnvalidatedSchemas(document, [], extra);
  await validateKafkaKeys(document, [], extra);
  return { parser: compact(output.diagnostics), extra };
}

/** The importer's step 3: the parser's verdict on a document read from a file (`parser.validate` of the object, as the importer always did). */
async function importValidate(text: string): Promise<ImportValidateJobResult> {
  return { diagnostics: compact(await sharedParser().validate(JSON.parse(text) as RawAsyncApi3)) };
}

function parseSource(text: string): ParseSourceJobResult {
  return parseAsyncApiSource(text);
}

/** Runs one job. Throws only for a failure of the parser itself (a document's problems are in the answer). */
export async function handleJob(job: WireJob): Promise<JobResult> {
  switch (job.kind) {
    case "validate": return validate(job.text);
    case "importValidate": return importValidate(job.text);
    case "parseSource": return parseSource(job.text);
    default: throw new Error(`unknown parser job kind ${JSON.stringify((job as { kind?: unknown }).kind)}`);
  }
}
