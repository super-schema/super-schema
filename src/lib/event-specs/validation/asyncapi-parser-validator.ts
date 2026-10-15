import { DiagnosticSeverity, Parser, type Diagnostic as ParserDiagnostic } from "@asyncapi/parser";
import { AvroSchemaParser } from "@asyncapi/avro-schema-parser";
import { ProtoBuffSchemaParser } from "@asyncapi/protobuf-schema-parser";
import { err, ok, type Result } from "@/types/result";
import type { Diagnostic, DiagnosticSeverity as EventSpecSeverity } from "../types";
import { diagnostic, normalizeDiagnostics } from "../diagnostics";
import { jsonPointer } from "../json-pointer";
import type { EventSpecValidator } from "../validator";

/**
 * Story 18.5 — `@asyncapi/parser` (v3) backed `EventSpecValidator`.
 *
 * Node-only and heavy (Spectral ruleset, Ajv, avsc, protobufjs): import it from
 * server code only, never from client components, and it is intentionally NOT
 * re-exported from the `event-specs` barrel. Opt in per adapter:
 *
 *   new AsyncApi3Adapter({ validators: [new AsyncApiParserValidator()] })
 *
 * Security (spec §10, SSRF): remote `$ref` resolution is OFF. The parser's
 * default `file` / `http` / `https` resolvers are always installed and a
 * throwing custom resolver does not stop them (the parser falls through to the
 * next one), so each scheme gets an `order: 1` resolver that answers with a
 * document holding a dangling local `$ref`. Any non-local `$ref` therefore fails
 * loudly (`invalid-ref`) and nothing is fetched or read. On top of that,
 * `validate()` rejects non-local `$ref`s up front (`REMOTE_REF`) without invoking
 * the parser at all.
 */

/** Answer served for every non-local `$ref`: resolves to a dangling pointer → `invalid-ref` error. */
const REMOTE_REF_BLOCKED_DOCUMENT = JSON.stringify({ $ref: "#/remote-references-are-disabled" });

const BLOCKED_SCHEMES = ["file", "http", "https"] as const;

/**
 * A parser with the Avro and Protobuf schema parsers registered and remote
 * `$ref` resolution disabled. Exported for tests and for callers that need the
 * parsed document model; `validate()` uses one lazily-created instance.
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

/** Parser severity (`@stoplight/types`): 0 error, 1 warning, 2 information, 3 hint. */
function mapSeverity(severity: DiagnosticSeverity): EventSpecSeverity {
  if (severity === DiagnosticSeverity.Error) return "error";
  if (severity === DiagnosticSeverity.Warning) return "warning";
  return "info";
}

/** Parser diagnostic → `Diagnostic`; the RFC 6901 pointer is built from the diagnostic's `path`. */
export function mapParserDiagnostic(d: ParserDiagnostic): Diagnostic {
  return diagnostic(mapSeverity(d.severity), String(d.code), d.message, jsonPointer(...(d.path ?? [])));
}

/** Every non-local `$ref` in the document (any `$ref` key counts, as in the structural validator). */
function findRemoteRefs(node: unknown, path: Array<string | number>, out: Diagnostic[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => findRemoteRefs(item, [...path, i], out));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      if (!value.startsWith("#")) {
        out.push(
          diagnostic(
            "error",
            "REMOTE_REF",
            `Only local references are allowed, got "${value}"`,
            jsonPointer(...path),
          ),
        );
      }
    } else {
      findRemoteRefs(value, [...path, key], out);
    }
  }
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

export class AsyncApiParserValidator implements EventSpecValidator {
  readonly name = "asyncapi-parser";
  private parser: Parser | undefined;

  /**
   * Parse (not just validate) so the registered Avro / Protobuf schema parsers
   * also run over every payload. Document problems come back as diagnostics; only
   * a failure of the parser itself is an `err` Result. JSON Schema 2020-12 schemas, which the
   * parser cannot validate, are reported as `PAYLOAD_NOT_VALIDATED` warnings; Kafka key schemas
   * (which the parser never looks inside) are validated here (`KAFKA_KEY_SCHEMA_*` errors).
   */
  async validate(document: object): Promise<Result<Diagnostic[]>> {
    const remote: Diagnostic[] = [];
    findRemoteRefs(document, [], remote);
    if (remote.length > 0) return ok(normalizeDiagnostics(remote));

    try {
      this.parser ??= createAsyncApiParser();
      const output = await this.parser.parse(JSON.stringify(document));
      const notValidated: Diagnostic[] = [];
      findUnvalidatedSchemas(document, [], notValidated);
      const keyProblems: Diagnostic[] = [];
      await validateKafkaKeys(document, [], keyProblems);
      return ok(normalizeDiagnostics([...output.diagnostics.map(mapParserDiagnostic), ...notValidated, ...keyProblems]));
    } catch (e) {
      return err({
        code: "ASYNCAPI_PARSER_FAILED",
        message: `@asyncapi/parser failed to run: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}
