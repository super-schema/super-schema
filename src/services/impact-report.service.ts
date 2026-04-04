/**
 * Impact Report Service
 *
 * Generates impact reports for governance requests.
 * Aggregates data from classification, migration artifacts, and entity relationships.
 *
 * Pure computation — no direct DB writes. The report is consumed by governance service.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ChangeClassification } from "@/types/schemas/classification";
import type {
  ImpactReport,
  PerTargetImpact,
  AffectedConsumer,
  MigrationArtifactsSummary,
  MigrationComplexity,
} from "@/types/schemas/governance";
import type { DiffResult, DiffField } from "@/services/version-history/version.types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a complete impact report for a set of changes.
 *
 * @param classification - The change classification result
 * @param diff - The structured diff between versions
 * @param entityName - The entity name for summary
 * @param affectedConsumers - Pre-resolved list of affected consumers (callers handle DB lookup)
 */
export function generateImpactReport(
  classification: ChangeClassification,
  diff: DiffResult,
  entityName: string,
  affectedConsumers: AffectedConsumer[] = []
): Result<ImpactReport> {
  try {
    // Generate summary
    const summary = generateSummary(classification, diff, entityName);

    // Compute per-target impact
    const perTarget = computePerTargetImpact(classification, diff);

    // Generate migration artifacts summary
    const migrationArtifactsSummary =
      generateMigrationArtifactsSummary(diff);

    const report: ImpactReport = {
      summary,
      changeClassification: classification,
      perTarget,
      affectedConsumers,
      migrationArtifactsSummary,
    };

    return ok(report);
  } catch (error) {
    return err({
      code: "IMPACT_REPORT_ERROR",
      message: `Failed to generate impact report: ${error instanceof Error ? error.message : String(error)}`,
      suggestedFix: "Check the input data and try again.",
    });
  }
}

// ---------------------------------------------------------------------------
// Summary Generation
// ---------------------------------------------------------------------------

function generateSummary(
  classification: ChangeClassification,
  diff: DiffResult,
  entityName: string
): string {
  const parts: string[] = [];

  if (classification.changeType === "breaking") {
    parts.push("Breaking change:");
  } else if (classification.changeType === "classification-change") {
    parts.push("Classification change:");
  } else {
    parts.push("Non-breaking change:");
  }

  const counts: string[] = [];
  if (diff.summary.removed > 0) {
    counts.push(
      `${diff.summary.removed} field${diff.summary.removed !== 1 ? "s" : ""} removed`
    );
  }
  if (diff.summary.modified > 0) {
    counts.push(
      `${diff.summary.modified} field${diff.summary.modified !== 1 ? "s" : ""} modified`
    );
  }
  if (diff.summary.added > 0) {
    counts.push(
      `${diff.summary.added} field${diff.summary.added !== 1 ? "s" : ""} added`
    );
  }

  if (counts.length > 0) {
    parts.push(counts.join(", "));
  }

  const targetCount = classification.perTarget.length;
  parts.push(`affecting ${targetCount} target${targetCount !== 1 ? "s" : ""}`);

  return `${parts.join(" ")} on "${entityName}"`;
}

// ---------------------------------------------------------------------------
// Per-Target Impact
// ---------------------------------------------------------------------------

function computePerTargetImpact(
  classification: ChangeClassification,
  diff: DiffResult
): PerTargetImpact[] {
  return classification.perTarget.map((pt) => {
    const compatible = pt.changeType === "non-breaking";
    const migrationRequired = pt.changeType === "breaking";
    const migrationComplexity = computeMigrationComplexity(diff, pt.target);

    return {
      target: pt.target,
      compatible,
      migrationRequired,
      migrationComplexity,
      details: pt.details,
    };
  });
}

/**
 * Compute migration complexity based on the types of changes.
 *
 * - "trivial": only ADD COLUMN / optional field additions
 * - "moderate": type changes with safe conversions, schema evolution compatible
 * - "complex": field removals, breaking type changes, manual intervention required
 */
export function computeMigrationComplexity(
  diff: DiffResult,
  _target: string
): MigrationComplexity {
  const changedFields = diff.fields.filter(
    (f) => f.changeType !== "unchanged"
  );

  if (changedFields.length === 0) return "trivial";

  let hasRemoval = false;
  let hasTypeChange = false;
  let hasNullabilityBreaking = false;
  let onlyAdditions = true;

  for (const field of changedFields) {
    if (field.changeType === "removed") {
      hasRemoval = true;
      onlyAdditions = false;
    } else if (field.changeType === "modified") {
      onlyAdditions = false;
      const props = field.changedProperties ?? [];
      for (const prop of props) {
        if (prop.property === "type") hasTypeChange = true;
        if (
          prop.property === "nullable" &&
          prop.before === true &&
          prop.after === false
        ) {
          hasNullabilityBreaking = true;
        }
      }
    }
    // "added" keeps onlyAdditions true
  }

  if (hasRemoval || hasNullabilityBreaking) return "complex";
  if (hasTypeChange) return "moderate";
  if (onlyAdditions) return "trivial";
  return "moderate";
}

// ---------------------------------------------------------------------------
// Migration Artifacts Summary
// ---------------------------------------------------------------------------

function generateMigrationArtifactsSummary(
  diff: DiffResult
): MigrationArtifactsSummary {
  return {
    bigquery: generateBigQuerySummary(diff),
    avro: generateAvroSummary(diff),
    openapi: generateOpenAPISummary(diff),
  };
}

function generateBigQuerySummary(diff: DiffResult): string {
  const parts: string[] = [];
  const added = diff.fields.filter((f) => f.changeType === "added").length;
  const removed = diff.fields.filter((f) => f.changeType === "removed").length;
  const modified = diff.fields.filter((f) => f.changeType === "modified");

  const typeChanges = modified.filter((f) =>
    f.changedProperties?.some((p) => p.property === "type")
  ).length;

  if (added > 0) parts.push(`${added} ADD COLUMN`);
  if (removed > 0)
    parts.push(`${removed} DROP COLUMN with warning`);
  if (typeChanges > 0) parts.push(`${typeChanges} ALTER COLUMN type change`);

  if (parts.length === 0) return "No DDL changes required";
  return `${parts.length} ALTER TABLE statement${parts.length !== 1 ? "s" : ""} (${parts.join(", ")})`;
}

function generateAvroSummary(diff: DiffResult): string {
  const changedFields = diff.fields.filter(
    (f) => f.changeType !== "unchanged"
  );

  if (changedFields.length === 0) return "No schema changes";

  const hasBreaking = changedFields.some(
    (f) =>
      f.changeType === "removed" ||
      f.changedProperties?.some(
        (p) =>
          p.property === "type" ||
          (p.property === "nullable" && p.before === true && p.after === false)
      )
  );

  const allOptionalAdds =
    changedFields.every(
      (f) =>
        f.changeType === "added" && f.versionB?.nullable
    );

  if (allOptionalAdds) return "BACKWARD compatible — only optional field additions";
  if (hasBreaking) return "BREAKING — backward-incompatible changes detected";
  return "Schema evolution — review Avro compatibility report";
}

function generateOpenAPISummary(diff: DiffResult): string {
  const parts: string[] = [];

  const removedRequired = diff.fields.filter(
    (f) =>
      f.changeType === "removed" && f.versionA && !f.versionA.nullable
  ).length;

  const addedRequired = diff.fields.filter(
    (f) =>
      f.changeType === "added" && f.versionB && !f.versionB.nullable
  ).length;

  if (removedRequired > 0)
    parts.push(
      `${removedRequired} breaking change${removedRequired !== 1 ? "s" : ""} — required field${removedRequired !== 1 ? "s" : ""} removed`
    );
  if (addedRequired > 0)
    parts.push(
      `${addedRequired} breaking change${addedRequired !== 1 ? "s" : ""} — required field${addedRequired !== 1 ? "s" : ""} added`
    );

  if (parts.length === 0) return "No breaking API changes";
  return parts.join("; ");
}
