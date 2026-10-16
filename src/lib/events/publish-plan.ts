import { ok, err, type Result } from "@/types/result";
import type { BumpKind, ChangeKind, VersionNumber } from "@/lib/entity-versioning/types";
import { INITIAL_VERSION, formatVersionLabel, nextVersionNumber, resolveBump } from "@/lib/entity-versioning/version-math";
import type { BumpDecision } from "./bump-rules";

// The publish planner is generic: it only needs "what changed, what blocks, what the bump classifier said". The event document's
// own facts and classifier (`document/bump.ts`) feed it.
export type EventPublishBlockerKind =
  | "NO_CHANGES" | "UNPUBLISHED_PIN" | "MISSING_ENTITY" | "NAME_CONFLICT" | "UNRESOLVED_REFERENCE" | "VALIDATION_ERROR";

export interface EventPublishBlocker {
  kind: EventPublishBlockerKind;
  message: string;
  pointer?: string;
}

/** What the publish dialog shows (structurally a `PublishPreview`, Task 8). Never fails — blockers are data. */
export interface EventPublishAnalysis {
  isFirstPublish: boolean;
  latestLabel: string | null;
  suggestedBump: BumpKind | null;
  candidateLabels: Record<BumpKind, string> | null;
  initialLabel: string;
  reasons: string[];
  blockers: EventPublishBlocker[];
}

export interface EventPublishPlan {
  version: VersionNumber;
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  reasons: string[];
}

export interface LatestVersion extends VersionNumber {
  sequence: number;
}

export interface VersionedPublishInput {
  latest: LatestVersion | null;
  hasChanges: boolean;
  blockers: EventPublishBlocker[];
  /** null when it cannot be classified yet (e.g. an unpublished pin); ignored on a first publish. */
  bump: BumpDecision | null;
}

export function analyzeVersionedPublish(input: VersionedPublishInput): EventPublishAnalysis {
  const blockers = input.blockers.map((b) => ({ ...b }));
  if (input.latest && !input.hasChanges) {
    blockers.unshift({ kind: "NO_CHANGES", message: `No unpublished changes since v${formatVersionLabel(input.latest)}.` });
  }
  const initialLabel = formatVersionLabel(INITIAL_VERSION);
  if (!input.latest) {
    return { isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel, reasons: [], blockers };
  }
  return {
    isFirstPublish: false,
    latestLabel: formatVersionLabel(input.latest),
    suggestedBump: input.bump?.bump ?? null,
    candidateLabels: {
      MAJOR: formatVersionLabel(nextVersionNumber(input.latest, "MAJOR").version),
      MINOR: formatVersionLabel(nextVersionNumber(input.latest, "MINOR").version),
    },
    initialLabel,
    reasons: [...(input.bump?.reasons ?? [])],
    blockers,
  };
}

/** The version a publish will write, or every blocker at once (spec §10); raise-only bump (spec Q6). */
export function planVersionedPublish(input: VersionedPublishInput, requested?: BumpKind): Result<EventPublishPlan> {
  const analysis = analyzeVersionedPublish(input);
  if (analysis.blockers.length > 0) {
    return err({
      code: "PUBLISH_BLOCKED",
      message: analysis.blockers.map((b) => b.message).join("; "),
      details: { blockers: analysis.blockers },
      suggestedFix: "Resolve every blocker, then publish again.",
    });
  }
  if (!input.latest) {
    return ok({ version: { ...INITIAL_VERSION }, label: formatVersionLabel(INITIAL_VERSION), sequence: 1, changeKind: "INITIAL", reasons: [] });
  }
  // Fail closed: a republish whose changes could not be classified must not silently default to MINOR.
  if (analysis.suggestedBump === null) {
    return err({
      code: "INVALID_PLAN_INPUT",
      message: "The changes since the latest version could not be classified, so no version can be planned.",
      suggestedFix: "Reload and try again; report this if it persists.",
    });
  }
  const bump = resolveBump(analysis.suggestedBump, requested);
  if (!bump.success) return bump;
  const { version, changeKind } = nextVersionNumber(input.latest, bump.data);
  return ok({ version, label: formatVersionLabel(version), sequence: input.latest.sequence + 1, changeKind, reasons: [...analysis.reasons] });
}

/**
 * Label a publish would get with the suggested bump — used to emit `info.version` when blockers prevent planning.
 * An unclassified bump (null) yields the MAJOR candidate, never a silently low MINOR; it is only ever a preview label.
 */
export function provisionalLabel(analysis: EventPublishAnalysis): string {
  if (analysis.isFirstPublish || !analysis.candidateLabels) return analysis.initialLabel;
  return analysis.candidateLabels[analysis.suggestedBump ?? "MAJOR"];
}
