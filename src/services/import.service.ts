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
  MultiEntityImportResult,
} from "@/lib/importers/types";
import { parseAvroDocument } from "@/lib/importers/avro.importer";
import { parseBigQueryDDL } from "@/lib/importers/bigquery.importer";
import { parseProtobufDocument } from "@/lib/importers/protobuf.importer";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { parseTypeSpecSchema, type TypeSpecImportResult } from "@/lib/importers/typespec.importer";
import { detectFormat } from "@/lib/importers/format-detector";
import {
  countImportAssets,
  lowConfidenceWarning,
  lowConfidenceWarnings,
  toAssetImportResult,
  toSingleEntityImport,
} from "@/lib/importers/multi-asset";

// ---------------------------------------------------------------------------
// Route to the correct parser
// ---------------------------------------------------------------------------

/** Formats whose importer returns every asset of the document. */
function parseDocumentWithFormat(
  content: string,
  format: ImportFormat
): Result<MultiEntityImportResult> | null {
  switch (format) {
    case "avro":
      return parseAvroDocument(content);
    case "protobuf":
      return parseProtobufDocument(content);
    case "json-schema":
      return parseJsonSchemaDocument(content);
    default:
      return null;
  }
}

/**
 * Single-entity parse: the document's root entity plus the document warnings
 * (and a note naming sibling entities a multi-entity document also defines).
 */
function parseWithFormat(
  content: string,
  format: ImportFormat
): Result<ImportResult> {
  const doc = parseDocumentWithFormat(content, format);
  if (doc) {
    return doc.success ? ok(toSingleEntityImport(doc.data)) : doc;
  }

  let single: Result<ParsedEntity>;
  switch (format) {
    case "bigquery-ddl":
      single = parseBigQueryDDL(content);
      break;
    case "typespec":
      single = parseTypeSpecSchema(content);
      break;
    default:
      return err({
        code: "UNSUPPORTED_FORMAT",
        message: `Unsupported import format: ${format}`,
        suggestedFix:
          "Supported formats are: avro, bigquery-ddl, protobuf, json-schema, typespec.",
      });
  }
  return single.success ? ok({ parsedEntity: single.data, warnings: [...(single.data.importWarnings ?? [])] }) : single;
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

  const { parsedEntity, warnings } = parseResult.data;
  return ok({
    parsedEntity,
    // Document warnings first, then low-confidence field notes.
    warnings: [...warnings, ...lowConfidenceWarnings(parsedEntity, false)],
  });
}

// ---------------------------------------------------------------------------
// importSchemaAssets — parse a document that may define several assets
// ---------------------------------------------------------------------------

/** Where the UI should send an import: the single-entity review or the multi-asset review. */
export type SchemaImportRoute =
  | { kind: "single"; result: ImportResult }
  | { kind: "multi"; result: TypeSpecImportResult };

/**
 * Parse a Protobuf / Avro / JSON Schema document into all of its assets and
 * pick the review path: more than one asset (entities + enums + scalars) goes
 * to the multi-asset review; one asset stays on the single-entity review.
 * Other formats use `importSchema` (TypeSpec / OpenAPI are compiled by their
 * server actions before this is reached).
 */
export function importSchemaAssets(
  content: string,
  format?: ImportFormat | null
): Result<SchemaImportRoute> {
  const resolvedFormat = format || detectFormat(content);
  const docResult = resolvedFormat ? parseDocumentWithFormat(content, resolvedFormat) : null;

  if (!docResult) {
    const single = importSchema(content, resolvedFormat);
    return single.success ? ok({ kind: "single", result: single.data }) : single;
  }
  if (!docResult.success) return docResult;

  const doc = docResult.data;
  if (countImportAssets(doc) > 1) {
    return ok({ kind: "multi", result: toAssetImportResult(doc) });
  }

  const single = toSingleEntityImport(doc);
  return ok({
    kind: "single",
    result: {
      parsedEntity: single.parsedEntity,
      warnings: [...single.warnings, ...lowConfidenceWarnings(single.parsedEntity, false)],
    },
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

    const { parsedEntity } = result.data;
    parsed.push(parsedEntity);

    // Document warnings (incl. sibling entities left out), then low-confidence notes
    for (const warning of result.data.warnings) {
      warnings.push(`${file.filename} — ${warning}`);
    }
    for (const field of parsedEntity.fields) {
      if (field.confidence === "low") {
        warnings.push(
          field.danglingRef
            ? `${file.filename} — ${lowConfidenceWarning(field, field.name)}`
            : `${file.filename} — field "${field.name}": low confidence mapping from ${field.originalType} to ${field.type}`
        );
      }
    }
  }

  return ok({ parsed, errors, warnings });
}
