/**
 * OpenAPI Breaking Change Detector
 *
 * Pure function: takes a ChangeEntry[] diff and detects breaking vs non-breaking
 * API changes according to OpenAPI compatibility rules.
 *
 * Breaking changes:
 * - Required field removed (consumers expect it in responses)
 * - Required field added (consumers must send it in requests)
 * - Type changed (serialization/deserialization incompatibility)
 * - Field renamed (appears as remove + add)
 *
 * Non-breaking changes:
 * - Optional field added
 * - Optional field removed
 * - Description changed
 * - Other metadata changes
 *
 * No side effects, no database access.
 */

import type { ChangeEntry } from "@/services/version-history/version.types";
import type {
  OpenAPIChange,
  OpenAPIBreakingChangeResult,
  MigrationArtifact,
} from "./migration.types";

// ---------------------------------------------------------------------------
// Breaking Change Detection
// ---------------------------------------------------------------------------

/**
 * Detect breaking and non-breaking OpenAPI changes from a set of field diffs.
 *
 * @param changes - The list of field changes from computeFieldDiff()
 * @returns OpenAPIBreakingChangeResult with categorized changes
 */
export function detectOpenAPIBreakingChanges(
  changes: ChangeEntry[]
): OpenAPIBreakingChangeResult {
  const breakingChanges: OpenAPIChange[] = [];
  const nonBreakingChanges: OpenAPIChange[] = [];

  for (const change of changes) {
    switch (change.type) {
      case "added": {
        const field = change.details.after!;
        if (field.nullable) {
          nonBreakingChanges.push({
            field: field.name,
            change: "added",
            severity: "non-breaking",
            description: `Added optional property "${field.name}" (type: ${field.type}) — clients can ignore this field`,
          });
        } else {
          breakingChanges.push({
            field: field.name,
            change: "added",
            severity: "breaking",
            description: `Added required property "${field.name}" (type: ${field.type}) — existing clients must be updated to provide this field`,
          });
        }
        break;
      }

      case "removed": {
        const field = change.details.before!;
        if (field.nullable) {
          nonBreakingChanges.push({
            field: field.name,
            change: "removed",
            severity: "non-breaking",
            description: `Removed optional property "${field.name}" (type: ${field.type}) — clients should stop sending this field`,
          });
        } else {
          breakingChanges.push({
            field: field.name,
            change: "removed",
            severity: "breaking",
            description: `Removed required property "${field.name}" (type: ${field.type}) — clients relying on this field will break`,
          });
        }
        break;
      }

      case "modified": {
        const before = change.details.before!;
        const after = change.details.after!;
        const changedProps = change.details.changedProperties;

        if (changedProps.includes("type")) {
          breakingChanges.push({
            field: after.name,
            change: "type-changed",
            severity: "breaking",
            description: `Type of property "${after.name}" changed from "${before.type}" to "${after.type}" — clients using the old type will fail`,
          });
        }

        if (changedProps.includes("nullable")) {
          if (before.nullable && !after.nullable) {
            breakingChanges.push({
              field: after.name,
              change: "made-required",
              severity: "breaking",
              description: `Property "${after.name}" changed from optional to required — clients not sending this field will fail`,
            });
          } else if (!before.nullable && after.nullable) {
            nonBreakingChanges.push({
              field: after.name,
              change: "made-optional",
              severity: "non-breaking",
              description: `Property "${after.name}" changed from required to optional — clients can continue sending this field`,
            });
          }
        }

        if (changedProps.includes("name")) {
          breakingChanges.push({
            field: after.name,
            change: "renamed",
            severity: "breaking",
            description: `Property renamed from "${before.name}" to "${after.name}" — clients using the old name will fail`,
          });
        }

        // Description and other metadata changes are non-breaking
        const metadataProps = changedProps.filter(
          (p) => !["type", "nullable", "name"].includes(p)
        );
        if (metadataProps.length > 0 && !changedProps.includes("type") && !changedProps.includes("nullable") && !changedProps.includes("name")) {
          nonBreakingChanges.push({
            field: after.name,
            change: "metadata-changed",
            severity: "non-breaking",
            description: `Property "${after.name}" metadata updated (${metadataProps.join(", ")}) — no client impact`,
          });
        }

        break;
      }
    }
  }

  return {
    breakingChanges,
    nonBreakingChanges,
    hasBreakingChanges: breakingChanges.length > 0,
  };
}

// ---------------------------------------------------------------------------
// OpenAPI Migration Artifact Generator
// ---------------------------------------------------------------------------

/**
 * Generate an OpenAPI changelog as a MigrationArtifact.
 *
 * @param changes - The list of field changes from computeFieldDiff()
 * @returns MigrationArtifact containing the changelog
 */
export function generateOpenAPIMigration(
  changes: ChangeEntry[]
): MigrationArtifact {
  const result = detectOpenAPIBreakingChanges(changes);

  const lines: string[] = [];
  lines.push("# OpenAPI Schema Changelog");
  lines.push("");

  if (result.breakingChanges.length > 0) {
    lines.push("## Breaking Changes");
    lines.push("");
    for (const change of result.breakingChanges) {
      lines.push(`- [BREAKING] ${change.description}`);
    }
    lines.push("");
  }

  if (result.nonBreakingChanges.length > 0) {
    lines.push("## Non-Breaking Changes");
    lines.push("");
    for (const change of result.nonBreakingChanges) {
      lines.push(`- ${change.description}`);
    }
    lines.push("");
  }

  if (result.breakingChanges.length === 0 && result.nonBreakingChanges.length === 0) {
    lines.push("No changes detected.");
    lines.push("");
  }

  const warnings: string[] = [];
  if (result.hasBreakingChanges) {
    warnings.push(
      `${result.breakingChanges.length} breaking change(s) detected — API consumers must be updated before deploying this schema version`
    );
  }

  return {
    type: "changelog",
    content: lines.join("\n"),
    warnings,
  };
}
