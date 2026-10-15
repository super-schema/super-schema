import type { FormatProfile, JsonSchemaDialect } from "./types";

/** Spec §2: draft-07 is the default JSON Schema dialect (AsyncAPI compatibility). */
export const DEFAULT_JSON_SCHEMA_DIALECT: JsonSchemaDialect = "draft-07";

/** Spec §7.2 step 4 — the exact `schemaFormat` strings. */
export const SCHEMA_FORMATS = {
  avro: "application/vnd.apache.avro+json;version=1.9.0",
  protobuf: "application/vnd.google.protobuf;version=3",
  jsonSchemaDraft07: "application/schema+json;version=draft-07",
  jsonSchema202012: "application/schema+json;version=2020-12",
} as const;

/** Fill the JSON Schema dialect default; drop a dialect on non-JSON formats. */
export function normalizeProfile(profile: FormatProfile): FormatProfile {
  return profile.format === "json-schema"
    ? { format: "json-schema", dialect: profile.dialect ?? DEFAULT_JSON_SCHEMA_DIALECT }
    : { format: profile.format };
}

export function sameProfile(a: FormatProfile, b: FormatProfile): boolean {
  const x = normalizeProfile(a);
  const y = normalizeProfile(b);
  return x.format === y.format && x.dialect === y.dialect;
}

export function schemaFormatFor(profile: FormatProfile): string {
  const p = normalizeProfile(profile);
  switch (p.format) {
    case "avro":
      return SCHEMA_FORMATS.avro;
    case "protobuf":
      return SCHEMA_FORMATS.protobuf;
    case "json-schema":
      return p.dialect === "2020-12" ? SCHEMA_FORMATS.jsonSchema202012 : SCHEMA_FORMATS.jsonSchemaDraft07;
  }
}

/** Suffix that qualifies one Message emitted in several formats (`OrderCreated_avro` / `OrderCreated_json`). */
export function formatSuffix(profile: FormatProfile): string {
  const p = normalizeProfile(profile);
  if (p.format === "avro") return "avro";
  if (p.format === "protobuf") return "proto";
  return p.dialect === "2020-12" ? "json2020" : "json";
}

/** Wire content types implied by a format profile (controller ruling R28). */
export const FORMAT_CONTENT_TYPES = {
  avro: "avro/binary",
  jsonSchema: "application/json",
  protobuf: "application/x-protobuf",
} as const;

/** Default message `contentType` for a payload emitted in `profile` (any JSON Schema dialect → `application/json`). */
export function contentTypeFor(profile: FormatProfile): string {
  switch (normalizeProfile(profile).format) {
    case "avro":
      return FORMAT_CONTENT_TYPES.avro;
    case "protobuf":
      return FORMAT_CONTENT_TYPES.protobuf;
    case "json-schema":
      return FORMAT_CONTENT_TYPES.jsonSchema;
  }
}
