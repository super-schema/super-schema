import { computeDiffResult } from "@/lib/diff/field-diff";
import { classifyFromDiff } from "@/services/classification.service";
import type { DiffResult, FieldSnapshot } from "@/services/version-history/version.types";
import type { BumpKind } from "./types";

export interface BumpSuggestion {
  bump: BumpKind;
  /** Human-readable reasons: core field rules + any breaking per-target findings. */
  reasons: string[];
  summary: { added: number; removed: number; modified: number };
}

/** Snapshot properties whose change is documentation only: it never alters the contract a consumer reads. */
const DOC_ONLY_PROPERTIES: ReadonlySet<string> = new Set(["description", "sortOrder"]);

/** No field added or removed, and every modified field changed only documentation-only properties (or nothing changed). */
function isDocOnly(diff: DiffResult): boolean {
  if (diff.summary.added > 0 || diff.summary.removed > 0) return false;
  return diff.fields.every(
    (field) => field.changeType !== "modified" || (field.changedProperties ?? []).every((change) => DOC_ONLY_PROPERTIES.has(change.property))
  );
}

/**
 * Phase 2a classifier: MAJOR when the existing field-level rules (classifyFromDiff,
 * incl. its BigQuery/Avro/OpenAPI target checks) call the change breaking; PATCH when the change
 * is documentation only (`description` / `sortOrder`, or no field change at all); else MINOR.
 * Story 14.3's per-format rule tables (Avro / JSON Schema / Proto) replace this in 2b.
 */
export function suggestBump(previous: FieldSnapshot[], current: FieldSnapshot[]): BumpSuggestion {
  const diff = computeDiffResult(previous, current, 0, 0);
  const classification = classifyFromDiff(diff);
  const breakingTargets = classification.perTarget
    .filter((t) => t.changeType === "breaking")
    .map((t) => `${t.target}: ${t.details}`);
  return {
    bump: classification.changeType === "breaking" ? "MAJOR" : isDocOnly(diff) ? "PATCH" : "MINOR",
    reasons: [...classification.reasons, ...breakingTargets],
    summary: { added: diff.summary.added, removed: diff.summary.removed, modified: diff.summary.modified },
  };
}
