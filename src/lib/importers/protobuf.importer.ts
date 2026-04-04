/**
 * Protobuf (.proto) Importer — parses .proto file into ParsedEntity.
 *
 * Handles:
 * - syntax = "proto3" detection
 * - message MessageName { ... } extraction
 * - Scalar types: string, int32, int64, float, double, bool, bytes, etc.
 * - Well-known types: google.protobuf.Timestamp
 * - Field numbers preservation
 * - optional keyword in proto3
 * - map<K,V> and oneof (flagged as low confidence)
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ParsedEntity, ParsedField, ImportConfidence } from "./types";

// ---------------------------------------------------------------------------
// Protobuf → Logical type mapping
// ---------------------------------------------------------------------------

const PROTO_TYPE_MAP: Record<string, { type: string; confidence: ImportConfidence }> = {
  string: { type: "string", confidence: "high" },
  int32: { type: "int32", confidence: "high" },
  int64: { type: "int64", confidence: "high" },
  sint32: { type: "int32", confidence: "high" },
  sint64: { type: "int64", confidence: "high" },
  uint32: { type: "uint32", confidence: "high" },
  uint64: { type: "uint64", confidence: "high" },
  fixed32: { type: "uint32", confidence: "medium" },
  fixed64: { type: "uint64", confidence: "medium" },
  sfixed32: { type: "int32", confidence: "medium" },
  sfixed64: { type: "int64", confidence: "medium" },
  float: { type: "float32", confidence: "high" },
  double: { type: "float64", confidence: "high" },
  bool: { type: "boolean", confidence: "high" },
  bytes: { type: "bytes", confidence: "high" },
  "google.protobuf.Timestamp": { type: "utcDateTime", confidence: "high" },
  "google.protobuf.Duration": { type: "duration", confidence: "high" },
  "google.protobuf.Any": { type: "string", confidence: "low" },
};

// ---------------------------------------------------------------------------
// Resolve protobuf type
// ---------------------------------------------------------------------------

function resolveProtoType(typeStr: string): {
  type: string;
  confidence: ImportConfidence;
  originalType: string;
} {
  // Check well-known types first
  const mapped = PROTO_TYPE_MAP[typeStr];
  if (mapped) {
    return {
      type: mapped.type,
      confidence: mapped.confidence,
      originalType: typeStr,
    };
  }

  // map<K,V>
  if (typeStr.startsWith("map<")) {
    return {
      type: "map",
      confidence: "low",
      originalType: typeStr,
    };
  }

  // repeated type → array
  if (typeStr.startsWith("repeated ")) {
    return {
      type: "array",
      confidence: "medium",
      originalType: typeStr,
    };
  }

  // Any other type (nested message, enum reference) → low confidence
  return {
    type: "string",
    confidence: "low",
    originalType: typeStr,
  };
}

// ---------------------------------------------------------------------------
// Parse field lines inside a message block
// ---------------------------------------------------------------------------

function parseProtoField(line: string, isProto3: boolean): ParsedField | null {
  const trimmed = line.trim();

  // Skip empty, comments, closing braces, reserved, option statements
  if (
    !trimmed ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed === "}" ||
    trimmed.startsWith("reserved ") ||
    trimmed.startsWith("option ") ||
    trimmed.startsWith("enum ") ||
    trimmed.startsWith("message ") ||
    trimmed.startsWith("oneof ")
  ) {
    return null;
  }

  // Match: [optional|repeated] type name = number [;] [// comment]
  const match = trimmed.match(
    /^(optional\s+|repeated\s+|required\s+)?(map<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*(\d+)\s*;?\s*(?:\/\/\s*(.*))?$/
  );

  if (!match) {
    return null;
  }

  const modifier = (match[1] || "").trim();
  let typeStr = match[2];
  const name = match[3];
  const fieldNumber = parseInt(match[4], 10);
  const comment = match[5]?.trim();

  // Handle repeated as array
  if (modifier === "repeated") {
    typeStr = `repeated ${typeStr}`;
  }

  const resolved = resolveProtoType(typeStr);

  // In proto3, all fields are implicitly optional unless explicitly marked
  const nullable = isProto3 ? true : modifier === "optional";

  return {
    name,
    type: resolved.type,
    nullable,
    description: comment || undefined,
    fieldNumber,
    confidence: resolved.confidence,
    originalType: resolved.originalType,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseProtobufSchema(content: string): Result<ParsedEntity> {
  const lines = content.split("\n");

  // Detect proto3 syntax
  const isProto3 = lines.some((line) =>
    /^\s*syntax\s*=\s*"proto3"\s*;/.test(line)
  );

  // Find the first message definition
  let messageName: string | null = null;
  let messageStart = -1;
  let braceDepth = 0;
  let messageEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (!messageName) {
      const match = trimmed.match(/^message\s+(\w+)\s*\{/);
      if (match) {
        messageName = match[1];
        messageStart = i;
        // Count braces on this line
        for (const ch of trimmed) {
          if (ch === "{") braceDepth++;
          if (ch === "}") braceDepth--;
        }
        if (braceDepth === 0) {
          messageEnd = i;
          break;
        }
        continue;
      }
    }

    if (messageName && messageStart >= 0) {
      for (const ch of trimmed) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      if (braceDepth === 0) {
        messageEnd = i;
        break;
      }
    }
  }

  if (!messageName) {
    return err({
      code: "PARSE_ERROR",
      message: "No message definition found in .proto file",
      suggestedFix: 'Ensure the .proto file contains a "message MessageName { ... }" definition.',
    });
  }

  if (messageEnd === -1) {
    messageEnd = lines.length - 1;
  }

  // Parse fields within the message block
  // Handle inline single-line message: message M { string x = 1; }
  let fieldLines: string[];
  if (messageStart === messageEnd) {
    // Single-line message — extract content between { and }
    const line = lines[messageStart];
    const openIdx = line.indexOf("{");
    const closeIdx = line.lastIndexOf("}");
    if (openIdx !== -1 && closeIdx > openIdx) {
      const inlineContent = line.substring(openIdx + 1, closeIdx);
      fieldLines = inlineContent.split(";").map((s) => s.trim() + ";").filter((s) => s !== ";");
    } else {
      fieldLines = [];
    }
  } else {
    fieldLines = lines.slice(messageStart + 1, messageEnd);
  }
  const parsedFields: ParsedField[] = [];

  for (const line of fieldLines) {
    const field = parseProtoField(line, isProto3);
    if (field) {
      parsedFields.push(field);
    }
  }

  return ok({
    name: messageName,
    fields: parsedFields,
    sourceFormat: "protobuf",
    originalContent: content,
  });
}
