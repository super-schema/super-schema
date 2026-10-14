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

export class AsyncApiParserValidator implements EventSpecValidator {
  readonly name = "asyncapi-parser";
  private parser: Parser | undefined;

  /**
   * Parse (not just validate) so the registered Avro / Protobuf schema parsers
   * also run over every payload. Document problems come back as diagnostics; only
   * a failure of the parser itself is an `err` Result.
   */
  async validate(document: object): Promise<Result<Diagnostic[]>> {
    const remote: Diagnostic[] = [];
    findRemoteRefs(document, [], remote);
    if (remote.length > 0) return ok(normalizeDiagnostics(remote));

    try {
      this.parser ??= createAsyncApiParser();
      const output = await this.parser.parse(JSON.stringify(document));
      return ok(normalizeDiagnostics(output.diagnostics.map(mapParserDiagnostic)));
    } catch (e) {
      return err({
        code: "ASYNCAPI_PARSER_FAILED",
        message: `@asyncapi/parser failed to run: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}
