/**
 * Format auto-detector for schema import.
 *
 * Detects the schema format by:
 * 1. File extension (if filename is provided)
 * 2. Content analysis (JSON structure, SQL keywords, proto keywords)
 *
 * Returns null if format cannot be determined.
 */

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

// ---------------------------------------------------------------------------
// Content-based detection
// ---------------------------------------------------------------------------

function detectByContent(content: string): ImportFormat | null {
  const trimmed = content.trim();

  // Check for Avro JSON: has "type": "record"
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "record" && parsed.fields) {
        return "avro";
      }
    } catch {
      // Not valid JSON, continue checking
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
  // Try extension first
  if (filename) {
    const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
    const byExt = EXTENSION_MAP[ext];
    if (byExt) {
      return byExt;
    }
  }

  // Fall back to content analysis
  return detectByContent(content);
}
