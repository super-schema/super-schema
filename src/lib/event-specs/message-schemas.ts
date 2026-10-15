import type { Diagnostic, FormatProfile, JsonObject, SchemaArtifact } from "./types";
import { diagnostic } from "./diagnostics";
import { downConvertToDraft07 } from "./json-schema-downconvert";
import { mapSchemaRefs } from "./json-schema-keywords";
import { normalizeProfile, sameProfile } from "./schema-format";

/**
 * Spec §7.2 step 3 — which pre-rendered schema goes where:
 * - payload: the artifact in the channel's format profile (2020-12 is
 *   down-converted when the channel wants draft-07 and only 2020-12 exists);
 * - headers: always a JSON Schema object schema, emitted as a plain AsyncAPI
 *   Schema Object (draft-07 compatible);
 * - Kafka key: Avro when the channel is Avro, otherwise JSON Schema draft-07,
 *   placed at `bindings.kafka.key`. The Kafka binding types `key` as a JSON Schema
 *   Object, so an Avro key is emitted tagged like a payload — a Multi Format Schema
 *   Object `{ schemaFormat, schema }` (assemble.ts) — never as a bare Avro record.
 * Embedded JSON Schemas get their local `$ref`s rebased onto their location in
 * the AsyncAPI document so they stay resolvable from the document root.
 */

export type SchemaRole = "payload" | "key";

export type SchemaSelection = { schema?: JsonObject | string; diagnostics: Diagnostic[] };

const MISSING_CODE: Record<SchemaRole, string> = {
  payload: "PAYLOAD_ARTIFACT_MISSING",
  key: "KEY_ARTIFACT_MISSING",
};

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function describe(profile: FormatProfile): string {
  const p = normalizeProfile(profile);
  return p.dialect ? `${p.format} (${p.dialect})` : p.format;
}

function shapeIsValid(artifact: SchemaArtifact): boolean {
  return artifact.format === "protobuf" ? typeof artifact.schema === "string" : isObject(artifact.schema);
}

/**
 * Rewrite local refs (`#/definitions/X`) to absolute document refs (`#<basePointer>/definitions/X`).
 * Schema-position aware (see `json-schema-keywords.ts`): only `$ref`s in schema positions are
 * rebased, so a property called `default` / `enum` / `const` / `examples` is rebased like any
 * other property, while data keywords (`const`, `enum`, `default`, `examples`) are left untouched.
 */
export function rebaseLocalRefs(schema: JsonObject, basePointer: string): JsonObject {
  return mapSchemaRefs(schema, (ref) => (ref.startsWith("#") ? `#${basePointer}${ref.slice(1)}` : ref));
}

function downConverted(schema: JsonObject, pointer: string): { schema: JsonObject; diagnostics: Diagnostic[] } {
  const result = downConvertToDraft07(schema);
  return {
    schema: result.schema,
    diagnostics: result.warnings.map((w) =>
      diagnostic(
        "warning",
        w.kind === "rewritten" ? "SCHEMA_REF_SIBLINGS_WRAPPED" : "SCHEMA_KEYWORD_DROPPED",
        `Down-converting to draft-07: ${w.message}`,
        `${pointer}${w.pointer}`,
      ),
    ),
  };
}

/**
 * Pick the artifact for `profile`. `pointer` is where the schema lands in the
 * document (`…/payload/schema`, `…/bindings/kafka/key`).
 */
export function selectArtifact(
  artifacts: SchemaArtifact[],
  profile: FormatProfile,
  role: SchemaRole,
  pointer: string,
): SchemaSelection {
  const target = normalizeProfile(profile);
  const exact = artifacts.find((a) => sameProfile(a, target));
  const fallback =
    !exact && target.format === "json-schema" && target.dialect === "draft-07"
      ? artifacts.find((a) => sameProfile(a, { format: "json-schema", dialect: "2020-12" }))
      : undefined;
  const chosen = exact ?? fallback;

  if (!chosen) {
    return {
      diagnostics: [
        diagnostic("error", MISSING_CODE[role], `No ${role} schema rendered as ${describe(target)}`, pointer),
      ],
    };
  }
  if (!shapeIsValid(chosen)) {
    return {
      diagnostics: [
        diagnostic(
          "error",
          "SCHEMA_SHAPE_INVALID",
          `${describe(chosen)} ${role} schema must be ${chosen.format === "protobuf" ? ".proto source text" : "a JSON object"}`,
          pointer,
        ),
      ],
    };
  }
  if (typeof chosen.schema === "string") return { schema: chosen.schema, diagnostics: [] };
  if (target.format !== "json-schema") return { schema: structuredClone(chosen.schema), diagnostics: [] };
  if (fallback) {
    const converted = downConverted(chosen.schema, pointer);
    return { schema: rebaseLocalRefs(converted.schema, pointer), diagnostics: converted.diagnostics };
  }
  return { schema: rebaseLocalRefs(chosen.schema, pointer), diagnostics: [] };
}

/** Headers must be a JSON Schema whose `type` is `"object"`; 2020-12 is down-converted. */
export function headersSchema(
  artifact: SchemaArtifact,
  pointer: string,
): { schema?: JsonObject; diagnostics: Diagnostic[] } {
  const schema = artifact.schema;
  if (artifact.format !== "json-schema" || !isObject(schema) || schema.type !== "object") {
    return {
      diagnostics: [
        diagnostic(
          "error",
          "HEADERS_NOT_OBJECT_SCHEMA",
          "Headers must be a JSON Schema object schema (type: object); headers omitted",
          pointer,
        ),
      ],
    };
  }
  if (normalizeProfile(artifact).dialect === "2020-12") {
    const converted = downConverted(schema, pointer);
    return { schema: rebaseLocalRefs(converted.schema, pointer), diagnostics: converted.diagnostics };
  }
  return { schema: rebaseLocalRefs(schema, pointer), diagnostics: [] };
}

/** Spec §7.2 step 3: Avro key on an Avro channel, otherwise JSON Schema (draft-07). */
export function kafkaKeyProfile(channelProfile: FormatProfile): FormatProfile {
  return normalizeProfile(channelProfile).format === "avro"
    ? { format: "avro" }
    : { format: "json-schema", dialect: "draft-07" };
}

/**
 * Return a copy of `bindings` with `kafka.key` set (first key of `kafka`), keeping
 * every other binding. `overridden` reports a hand-written key that was replaced.
 */
export function placeKafkaKey(
  bindings: JsonObject | undefined,
  key: JsonObject | string,
): { bindings: JsonObject; overridden: boolean } {
  const copy: JsonObject = bindings ? structuredClone(bindings) : {};
  const kafka: JsonObject = isObject(copy.kafka) ? copy.kafka : {};
  const { key: previous, ...rest } = kafka;
  copy.kafka = { key, ...rest };
  return { bindings: copy, overridden: previous !== undefined };
}
