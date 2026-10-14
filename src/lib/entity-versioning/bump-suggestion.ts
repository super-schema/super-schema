import { computeDiffResult } from "@/lib/diff/field-diff";
import { classifyFromDiff } from "@/services/classification.service";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import type { BumpKind } from "./types";

export interface BumpSuggestion {
  bump: BumpKind;
  /** Human-readable reasons: core field rules + any breaking per-target findings. */
  reasons: string[];
  summary: { added: number; removed: number; modified: number };
}

/**
 * Phase 2a classifier: MAJOR when the existing field-level rules (classifyFromDiff,
 * incl. its BigQuery/Avro/OpenAPI target checks) call the change breaking, else MINOR.
 * Story 14.3's per-format rule tables (Avro / JSON Schema / Proto) replace this in 2b.
 */
export function suggestBump(previous: FieldSnapshot[], current: FieldSnapshot[]): BumpSuggestion {
  const diff = computeDiffResult(previous, current, 0, 0);
  const classification = classifyFromDiff(diff);
  const breakingTargets = classification.perTarget
    .filter((t) => t.changeType === "breaking")
    .map((t) => `${t.target}: ${t.details}`);
  return {
    bump: classification.changeType === "breaking" ? "MAJOR" : "MINOR",
    reasons: [...classification.reasons, ...breakingTargets],
    summary: { added: diff.summary.added, removed: diff.summary.removed, modified: diff.summary.modified },
  };
}
