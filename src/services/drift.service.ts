/**
 * Drift Detection Service — detects schema drift between logical entities
 * and their imported/registered implementations.
 *
 * Reuses import parsers from src/lib/importers/ to normalize both the
 * emitted output and the registered implementation into comparable field lists.
 *
 * Service layer pattern: all functions return Result<T, ServiceError>.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ParsedField } from "@/lib/importers/types";
import { parseAvroSchema } from "@/lib/importers/avro.importer";
import { parseBigQueryDDL } from "@/lib/importers/bigquery.importer";
import { parseProtobufSchema } from "@/lib/importers/protobuf.importer";
import {
  normalizeFieldList,
  compareFieldLists,
  determineDriftStatus,
} from "@/lib/drift/drift-comparator";
import type {
  DriftReport,
  DriftTargetStatus,
} from "@/lib/drift/drift-comparator";

// Re-export types used by consumers
export type { DriftReport, DriftTargetStatus };

// ---------------------------------------------------------------------------
// Parse content by format name
// ---------------------------------------------------------------------------

function parseByFormat(
  content: string,
  format: string
): Result<ParsedField[]> {
  let result;
  const normalizedFormat = format.toLowerCase();

  if (normalizedFormat === "avro" || normalizedFormat === "avro-schema") {
    result = parseAvroSchema(content);
  } else if (
    normalizedFormat === "bigquery-ddl" ||
    normalizedFormat === "bigquery"
  ) {
    result = parseBigQueryDDL(content);
  } else if (normalizedFormat === "protobuf" || normalizedFormat === "proto") {
    result = parseProtobufSchema(content);
  } else {
    return err({
      code: "UNSUPPORTED_FORMAT",
      message: `Cannot parse format "${format}" for drift detection`,
      suggestedFix: "Supported formats: avro, bigquery-ddl, protobuf.",
    });
  }

  if (!result.success) {
    return result;
  }

  return ok(result.data.fields);
}

// ---------------------------------------------------------------------------
// detectDrift — compare entity's current fields against imported source
// ---------------------------------------------------------------------------

export interface DetectDriftInput {
  entityId: string;
  entityName: string;
  /** The entity's importedFrom metadata */
  importedFrom?: {
    format: string;
    originalContent: string;
  } | null;
  /** The current fields on the entity (from the database) */
  currentFields: ParsedField[];
  /** Emission targets with their emitted output */
  emissionTargets?: {
    targetFormat: string;
    emittedOutput?: string | null;
  }[];
}

export function detectDrift(input: DetectDriftInput): Result<DriftReport> {
  const { entityId, entityName, importedFrom, currentFields, emissionTargets } =
    input;

  // If no importedFrom metadata, we cannot detect drift
  if (!importedFrom) {
    const targets: DriftTargetStatus[] = (emissionTargets || []).map((t) => ({
      targetFormat: t.targetFormat,
      driftStatus: "unknown" as const,
      differences: [],
    }));

    return ok({ entityId, entityName, targets });
  }

  // Parse the original imported content
  const importedFieldsResult = parseByFormat(
    importedFrom.originalContent,
    importedFrom.format
  );

  if (!importedFieldsResult.success) {
    // Cannot parse imported content → unknown
    const targets: DriftTargetStatus[] = (emissionTargets || []).map((t) => ({
      targetFormat: t.targetFormat,
      driftStatus: "unknown" as const,
      differences: [],
    }));
    return ok({ entityId, entityName, targets });
  }

  const importedFields = normalizeFieldList(importedFieldsResult.data);
  const logicalFields = normalizeFieldList(currentFields);

  // Compare logical fields against imported fields
  const differences = compareFieldLists(logicalFields, importedFields);
  const status = determineDriftStatus(differences);

  // If there are emission targets, compare each target output too
  const targets: DriftTargetStatus[] = [];

  if (emissionTargets && emissionTargets.length > 0) {
    for (const target of emissionTargets) {
      if (!target.emittedOutput) {
        targets.push({
          targetFormat: target.targetFormat,
          driftStatus: "unknown",
          differences: [],
        });
        continue;
      }

      const emittedFieldsResult = parseByFormat(
        target.emittedOutput,
        target.targetFormat
      );

      if (!emittedFieldsResult.success) {
        targets.push({
          targetFormat: target.targetFormat,
          driftStatus: "unknown",
          differences: [],
        });
        continue;
      }

      const emittedFields = normalizeFieldList(emittedFieldsResult.data);
      const targetDiffs = compareFieldLists(emittedFields, importedFields);
      const targetStatus = determineDriftStatus(targetDiffs);

      targets.push({
        targetFormat: target.targetFormat,
        driftStatus: targetStatus,
        differences: targetDiffs,
      });
    }
  } else {
    // No emission targets — just compare directly
    targets.push({
      targetFormat: importedFrom.format,
      driftStatus: status,
      differences,
    });
  }

  return ok({ entityId, entityName, targets });
}

// ---------------------------------------------------------------------------
// detectDriftForMultiple — batch drift detection
// ---------------------------------------------------------------------------

export function detectDriftForMultiple(
  inputs: DetectDriftInput[]
): Result<DriftReport[]> {
  const reports: DriftReport[] = [];

  for (const input of inputs) {
    const result = detectDrift(input);
    if (result.success) {
      reports.push(result.data);
    }
  }

  return ok(reports);
}
