/**
 * Format auto-detector for schema import.
 *
 * Detects the schema format by:
 * 1. File extension (if filename is provided)
 * 2. Content analysis (JSON structure, SQL keywords, proto keywords)
 *
 * Returns null if format cannot be determined.
 */

import { parseYamlBounded } from "./safe-yaml";
import type { ImportFormat } from "./types";

// ---------------------------------------------------------------------------
// Extension-based detection
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Record<string, ImportFormat> = {
  ".avsc": "avro",
  ".avro": "avro",
  ".sql": "bigquery-ddl",
  ".ddl": "bigquery-ddl",
  ".proto": "protobuf",
  ".tsp": "typespec",
};

/**
 * Extensions shared by several formats (Avro / JSON Schema / OpenAPI in .json,
 * JSON Schema / OpenAPI in .yaml/.yml): always decided by content.
 */
const CONTENT_SNIFFED_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

/** JSON Schema shape: $schema points at json-schema.org, or an object schema / definitions bundle. */
function looksLikeJsonSchema(parsed: Record<string, unknown>): boolean {
  const schemaUrl = typeof parsed.$schema === "string" ? parsed.$schema : "";
  return Boolean(
    schemaUrl.includes("json-schema.org") ||
      (parsed.type === "object" && parsed.properties) ||
      (parsed.properties && typeof parsed.properties === "object") ||
      parsed.$defs ||
      parsed.definitions
  );
}

/** Top-level YAML keys a JSON Schema document starts with. */
const YAML_JSON_SCHEMA_KEYS = /(^|\n)(\$schema|properties|\$defs|definitions)\s*:/;

// ---------------------------------------------------------------------------
// Content-based detection
// ---------------------------------------------------------------------------

function detectByContent(content: string): ImportFormat | null {
  const trimmed = content.trim();

  // Check for OpenAPI (JSON or YAML): has an `openapi: "3.x"` version field
  // plus a `paths` map. YAML is a superset of JSON, so one parse covers both.
  if (/"openapi"\s*:\s*"3\./.test(trimmed) || /(^|\n)\s*openapi\s*:\s*["']?3\./m.test(trimmed)) {
    // Bounded parse (an alias fan-out is refused, never expanded: see safe-yaml.ts). Not valid YAML/JSON: continue checking other formats.
    const parsedYaml = parseYamlBounded(trimmed);
    const parsed = parsedYaml.ok ? (parsedYaml.value as Record<string, unknown> | null) : null;
    if (parsed && typeof parsed === "object" && parsed.paths) {
      return "openapi";
    }
  }

  // Check for Avro JSON: has "type": "record"
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "record" && parsed.fields) {
        return "avro";
      }
      // JSON Schema — checked after Avro so records win.
      if (looksLikeJsonSchema(parsed)) {
        return "json-schema";
      }
    } catch {
      // Not valid JSON, continue checking
    }
  } else if (YAML_JSON_SCHEMA_KEYS.test(trimmed)) {
    // JSON Schema authored in YAML (top-level `properties:` / `$schema:` / `$defs:`).
    const parsedYaml = parseYamlBounded(trimmed);
    const parsed = parsedYaml.ok ? parsedYaml.value : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (looksLikeJsonSchema(parsed as Record<string, unknown>)) return "json-schema";
    }
  }

  // Check for BigQuery DDL: CREATE TABLE
  if (/CREATE\s+(?:OR\s+REPLACE\s+)?TABLE/i.test(trimmed)) {
    return "bigquery-ddl";
  }

  // Check for Protobuf: syntax = "proto" or message keyword
  if (/^\s*syntax\s*=\s*"proto/m.test(trimmed)) {
    return "protobuf";
  }
  if (/^\s*message\s+\w+\s*\{/m.test(trimmed)) {
    return "protobuf";
  }

  // Check for TypeSpec: import "@typespec", model/enum/scalar/union/interface/namespace keywords
  if (/^\s*import\s+"@typespec/m.test(trimmed)) {
    return "typespec";
  }
  if (/^\s*model\s+\w+\s*(?:extends\s+\w+\s*)?\{/m.test(trimmed)) {
    return "typespec";
  }
  if (/^\s*(?:enum|scalar|union|interface|namespace)\s+\w+/m.test(trimmed)) {
    return "typespec";
  }
  if (/(?:@doc|@key|@format|@secret)\s*(?:\(|$)/m.test(trimmed) && /model\s+\w+/m.test(trimmed)) {
    return "typespec";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function detectFormat(
  content: string,
  filename?: string
): ImportFormat | null {
  // Try extension first (.json / .yaml / .yml carry several formats → content)
  if (filename) {
    const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
    const byExt = CONTENT_SNIFFED_EXTENSIONS.has(ext) ? undefined : EXTENSION_MAP[ext];
    if (byExt) {
      return byExt;
    }
  }

  // Fall back to content analysis
  return detectByContent(content);
}
