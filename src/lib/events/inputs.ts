// src/lib/events/inputs.ts
import { ok, err, type Result } from "@/types/result";
import type { JsonObject, JsonSchemaDialect, JsonValue, PayloadFormat } from "@/lib/event-specs/types";

/** AsyncAPI component keys (`^[a-zA-Z0-9.\-_]+$`) — catalog names become component keys. */
export const CATALOG_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]{0,31}$/;

/** Suggestions for the protocol field; any AsyncAPI protocol string matching PROTOCOL_PATTERN is accepted. */
export const KNOWN_PROTOCOLS = [
  "kafka", "googlepubsub", "pulsar", "amqp", "amqp1", "anypointmq", "http", "ibmmq", "jms",
  "mqtt", "nats", "redis", "sns", "solace", "sqs", "stomp", "ws",
] as const;
export const PAYLOAD_FORMATS: readonly PayloadFormat[] = ["avro", "json-schema", "protobuf"];
export const JSON_SCHEMA_DIALECTS: readonly JsonSchemaDialect[] = ["draft-07", "2020-12"];

const invalid = (message: string, suggestedFix?: string) =>
  err({ code: "VALIDATION_ERROR", message, ...(suggestedFix && { suggestedFix }) });

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCatalogName(raw: string, kindLabel: string): Result<string> {
  const name = (raw ?? "").trim();
  if (!CATALOG_NAME_PATTERN.test(name)) {
    return invalid(
      `${kindLabel} name "${raw}" is invalid`,
      "Use 1–128 letters, digits, '.', '_' or '-' (the name becomes an AsyncAPI component key)."
    );
  }
  return ok(name);
}

export function normalizeProtocol(raw: string): Result<string> {
  const protocol = (raw ?? "").trim().toLowerCase();
  if (!PROTOCOL_PATTERN.test(protocol)) {
    return invalid(`Protocol "${raw}" is invalid`, `Use an AsyncAPI protocol such as ${KNOWN_PROTOCOLS.slice(0, 3).join(", ")}.`);
  }
  return ok(protocol);
}

export function normalizeFormatProfile(
  format: string,
  dialect: string | null | undefined
): Result<{ format: PayloadFormat; formatDialect: JsonSchemaDialect | null }> {
  if (!PAYLOAD_FORMATS.includes(format as PayloadFormat)) {
    return invalid(`Format "${format}" is not supported`, `Use one of ${PAYLOAD_FORMATS.join(", ")}.`);
  }
  const d = dialect?.trim() ? dialect.trim() : null;
  if (format !== "json-schema") {
    return d ? invalid(`A dialect is only valid for JSON Schema (got "${d}" for ${format})`) : ok({ format: format as PayloadFormat, formatDialect: null });
  }
  if (d && !JSON_SCHEMA_DIALECTS.includes(d as JsonSchemaDialect)) {
    return invalid(`JSON Schema dialect "${d}" is not supported`, `Use ${JSON_SCHEMA_DIALECTS.join(" or ")}.`);
  }
  return ok({ format: "json-schema", formatDialect: (d as JsonSchemaDialect | null) ?? "draft-07" });
}

function parseJsonText(text: string, label: string): Result<JsonValue | undefined> {
  if (!text.trim()) return ok(undefined);
  try {
    return ok(JSON.parse(text) as JsonValue);
  } catch (e) {
    return invalid(`${label} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function parseJsonObjectText(text: string, label: string): Result<JsonObject | undefined> {
  const parsed = parseJsonText(text, label);
  if (!parsed.success || parsed.data === undefined) return parsed as Result<undefined>;
  return isJsonObject(parsed.data) ? ok(parsed.data) : invalid(`${label} must be a JSON object`);
}

export function parseJsonObjectArrayText(text: string, label: string): Result<JsonObject[] | undefined> {
  const parsed = parseJsonText(text, label);
  if (!parsed.success || parsed.data === undefined) return parsed as Result<undefined>;
  return Array.isArray(parsed.data) && parsed.data.every(isJsonObject)
    ? ok(parsed.data as JsonObject[])
    : invalid(`${label} must be a JSON array of objects`);
}

export function formatJsonText(value: JsonValue | undefined): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}
