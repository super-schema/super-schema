/**
 * Change Classification Service
 *
 * Classifies schema changes as breaking, non-breaking, or classification-change.
 * Pure computation on diff results — no side effects, no data mutation.
 *
 * Flow:
 * 1. Get DiffResult from version diff
 * 2. Evaluate each field change against rule sets
 * 3. Evaluate per-target classification
 * 4. Aggregate overall classification
 * 5. Return ChangeClassification
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { DiffResult, DiffField } from "@/services/version-history/version.types";
import type { ChangeClassification } from "@/types/schemas/classification";
import type { PerTargetClassification } from "@/types/schemas/classification";
import {
  evaluateFieldChange,
  maxSeverity,
  aggregateChangeType,
  type ClassificationReason,
} from "./classification/rules";
import { classifyForBigQuery } from "./classification/target-classifiers/bigquery.classifier";
import { classifyForAvro } from "./classification/target-classifiers/avro.classifier";
import { classifyForOpenAPI } from "./classification/target-classifiers/openapi.classifier";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify changes from a DiffResult.
 * Pure function — takes a diff, returns a classification. No I/O.
 */
export function classifyFromDiff(diff: DiffResult): ChangeClassification {
  const allReasons: ClassificationReason[] = [];

  // Evaluate each field change against core rules
  for (const field of diff.fields) {
    const reasons = evaluateFieldChange(field);
    allReasons.push(...reasons);
  }

  // Per-target classification
  const changedFields = diff.fields.filter(
    (f) => f.changeType !== "unchanged"
  );
  const perTarget: PerTargetClassification[] = [
    classifyForBigQuery(changedFields),
    classifyForAvro(changedFields),
    classifyForOpenAPI(changedFields),
  ];

  // Aggregate classification
  // Overall changeType considers both core reasons AND per-target results
  const coreChangeType = aggregateChangeType(allReasons);
  const targetChangeTypes = perTarget.map((pt) => pt.changeType);
  const allChangeTypes = [coreChangeType, ...targetChangeTypes];

  let overallChangeType: ChangeClassification["changeType"] = "non-breaking";
  if (allChangeTypes.includes("breaking")) {
    overallChangeType = "breaking";
  } else if (allChangeTypes.includes("classification-change")) {
    overallChangeType = "classification-change";
  }

  const overallSeverity = maxSeverity(allReasons);

  return {
    changeType: overallChangeType,
    severity: allReasons.length > 0 ? overallSeverity : "low",
    reasons: allReasons.map((r) => r.reason),
    perTarget,
  };
}

/**
 * Classify changes between two version snapshots.
 * This is a convenience wrapper that builds a DiffResult-compatible input
 * from ChangeEntry data.
 *
 * For database-backed version comparison, use compareVersionsStructured()
 * from the version service, then pass the result to classifyFromDiff().
 */
export function classifyChanges(
  diff: DiffResult
): Result<ChangeClassification> {
  try {
    const classification = classifyFromDiff(diff);
    return ok(classification);
  } catch (error) {
    return err({
      code: "CLASSIFICATION_ERROR",
      message: `Failed to classify changes: ${error instanceof Error ? error.message : String(error)}`,
      suggestedFix: "Check the diff result format and try again.",
    });
  }
}
