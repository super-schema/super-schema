/**
 * Schema Import Service — orchestrates schema parsing, review, and entity creation.
 *
 * Service layer pattern: this module owns all import business logic.
 * All functions return Result<T, ServiceError> — never throw.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type {
  ImportFormat,
  ParsedEntity,
  ImportResult,
  BulkImportResult,
} from "@/lib/importers/types";
import { parseAvroSchema } from "@/lib/importers/avro.importer";
import { parseBigQueryDDL } from "@/lib/importers/bigquery.importer";
import { parseProtobufSchema } from "@/lib/importers/protobuf.importer";
import { parseJsonSchema } from "@/lib/importers/jsonschema.importer";
import { parseTypeSpecSchema } from "@/lib/importers/typespec.importer";
import { detectFormat } from "@/lib/importers/format-detector";

// ---------------------------------------------------------------------------
// Route to the correct parser
// ---------------------------------------------------------------------------

function parseWithFormat(
  content: string,
  format: ImportFormat
): Result<ParsedEntity> {
  switch (format) {
    case "avro":
      return parseAvroSchema(content);
    case "bigquery-ddl":
      return parseBigQueryDDL(content);
    case "protobuf":
      return parseProtobufSchema(content);
    case "json-schema":
      return parseJsonSchema(content);
    case "typespec":
      return parseTypeSpecSchema(content);
    default:
      return err({
        code: "UNSUPPORTED_FORMAT",
        message: `Unsupported import format: ${format}`,
        suggestedFix:
          "Supported formats are: avro, bigquery-ddl, protobuf, json-schema, typespec.",
      });
  }
}

// ---------------------------------------------------------------------------
// importSchema — parse a single schema file
// ---------------------------------------------------------------------------

export function importSchema(
  content: string,
  format?: ImportFormat | null,
  _options?: Record<string, unknown>
): Result<ImportResult> {
  // Auto-detect format if not provided
  const resolvedFormat = format || detectFormat(content);

  if (!resolvedFormat) {
    return err({
      code: "UNKNOWN_FORMAT",
      message: "Could not detect schema format from content",
      suggestedFix:
        "Specify the format explicitly or ensure the content matches a known schema format (Avro JSON, BigQuery DDL, Protobuf, or TypeSpec).",
    });
  }

  const parseResult = parseWithFormat(content, resolvedFormat);
  if (!parseResult.success) {
    return parseResult;
  }

  // Collect warnings for low-confidence fields
  const warnings: string[] = [];
  for (const field of parseResult.data.fields) {
    if (field.confidence === "low") {
      warnings.push(
        `Field "${field.name}": low confidence mapping from ${field.originalType} to ${field.type}`
      );
    }
  }

  return ok({
    parsedEntity: parseResult.data,
    warnings,
  });
}

// ---------------------------------------------------------------------------
// bulkImport — parse multiple files
// ---------------------------------------------------------------------------

export function bulkImport(
  files: { content: string; filename: string }[],
  _options?: Record<string, unknown>
): Result<BulkImportResult> {
  const parsed: ParsedEntity[] = [];
  const errors: { filename: string; error: string }[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const format = detectFormat(file.content, file.filename);
    if (!format) {
      errors.push({
        filename: file.filename,
        error: "Could not detect schema format",
      });
      continue;
    }

    const result = parseWithFormat(file.content, format);
    if (!result.success) {
      errors.push({
        filename: file.filename,
        error: result.error.message,
      });
      continue;
    }

    parsed.push(result.data);

    // Collect low-confidence warnings
    for (const field of result.data.fields) {
      if (field.confidence === "low") {
        warnings.push(
          `${file.filename} — field "${field.name}": low confidence mapping from ${field.originalType} to ${field.type}`
        );
      }
    }
  }

  return ok({ parsed, errors, warnings });
}
