import { ok, err, type Result } from "@/types/result";
import type { BumpKind, ChangeKind, VersionNumber } from "@/lib/entity-versioning/types";
import { INITIAL_VERSION, changeKindFrom, formatVersionLabel, resolveBump, snapshotVersionNumber } from "@/lib/entity-versioning/version-math";
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
  /** Nothing released yet: the snapshot is 1.0.0_snapshot whatever the bump. */
  isFirstPublish: boolean;
  /** The latest released label ("2.1.0"), null before the first release. */
  latestLabel: string | null;
  /** The open snapshot's label ("2.2.0_snapshot"), null when none is open. */
  openSnapshotLabel: string | null;
  /** Classified against the latest release; null before the first release (always 1.0.0) or when it cannot be classified yet. */
  suggestedBump: BumpKind | null;
  /** The snapshot label a save at each bump would produce (an open snapshot is never lowered); null before the first release. */
  candidateLabels: Record<BumpKind, string> | null;
  /** The first save's label ("1.0.0_snapshot"). */
  initialLabel: string;
  reasons: string[];
  blockers: EventPublishBlocker[];
}

export interface EventPublishPlan {
  /** CREATE a new snapshot row, or UPDATE the open one (`snapshotId`) in place, possibly at a raised number. */
  mode: "CREATE" | "UPDATE";
  /** The open snapshot an UPDATE writes; null for CREATE. */
  snapshotId: string | null;
  version: VersionNumber;
  /** The snapshot label, e.g. "2.2.0_snapshot" (the emitted `info.version`). */
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  reasons: string[];
}

export interface LatestVersion extends VersionNumber {
  id: string;
  sequence: number;
}

export interface VersionedPublishInput {
  /** The latest RELEASED version: new snapshot numbers count from it and the bump is classified against it. */
  latestRelease: LatestVersion | null;
  /** The event's one open (mutable) snapshot, if any: a save updates it in place instead of creating a version. */
  openSnapshot: LatestVersion | null;
  /** The draft differs from what the open snapshot holds (or, with none open, from the latest release). */
  hasChanges: boolean;
  blockers: EventPublishBlocker[];
  /** null when it cannot be classified yet (e.g. an unpublished pin); ignored before the first release. */
  bump: BumpDecision | null;
}

export function analyzeVersionedPublish(input: VersionedPublishInput): EventPublishAnalysis {
  const { latestRelease, openSnapshot } = input;
  const blockers = input.blockers.map((b) => ({ ...b }));
  if (!input.hasChanges) {
    if (openSnapshot) {
      blockers.unshift({ kind: "NO_CHANGES", message: `No unsaved changes since v${formatVersionLabel(openSnapshot, "SNAPSHOT")}.` });
    } else if (latestRelease) {
      blockers.unshift({ kind: "NO_CHANGES", message: `No unpublished changes since v${formatVersionLabel(latestRelease)}.` });
    }
  }
  const initialLabel = formatVersionLabel(INITIAL_VERSION, "SNAPSHOT");
  const openSnapshotLabel = openSnapshot ? formatVersionLabel(openSnapshot, "SNAPSHOT") : null;
  if (!latestRelease) {
    return { isFirstPublish: true, latestLabel: null, openSnapshotLabel, suggestedBump: null, candidateLabels: null, initialLabel, reasons: [], blockers };
  }
  const candidate = (bump: BumpKind) => formatVersionLabel(snapshotVersionNumber(latestRelease, openSnapshot, bump), "SNAPSHOT");
  return {
    isFirstPublish: false,
    latestLabel: formatVersionLabel(latestRelease),
    openSnapshotLabel,
    suggestedBump: input.bump?.bump ?? null,
    candidateLabels: { MAJOR: candidate("MAJOR"), MINOR: candidate("MINOR"), PATCH: candidate("PATCH") },
    initialLabel,
    reasons: [...(input.bump?.reasons ?? [])],
    blockers,
  };
}

/**
 * The snapshot a save writes, or every blocker at once (spec §10); raise-only bump (spec Q6). CREATE a snapshot when none is open,
 * numbered from the latest release; otherwise UPDATE the open one, raised when the resolved bump yields a higher number, never lowered.
 */
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
  const { latestRelease, openSnapshot } = input;
  let bump: BumpKind = "MINOR";
  if (latestRelease) {
    // Fail closed: a save whose changes could not be classified must not silently default to MINOR.
    if (analysis.suggestedBump === null) {
      return err({
        code: "INVALID_PLAN_INPUT",
        message: "The changes since the latest version could not be classified, so no version can be planned.",
        suggestedFix: "Reload and try again; report this if it persists.",
      });
    }
    const resolved = resolveBump(analysis.suggestedBump, requested);
    if (!resolved.success) return resolved;
    bump = resolved.data;
  }
  const version = snapshotVersionNumber(latestRelease, openSnapshot, bump);
  const sequence = openSnapshot ? openSnapshot.sequence : latestRelease ? latestRelease.sequence + 1 : 1;
  return ok({
    mode: openSnapshot ? "UPDATE" : "CREATE",
    snapshotId: openSnapshot?.id ?? null,
    version,
    label: formatVersionLabel(version, "SNAPSHOT"),
    sequence,
    changeKind: changeKindFrom(version, latestRelease),
    reasons: [...analysis.reasons],
  });
}

/**
 * Snapshot label a save would get with the suggested bump — used to emit `info.version` when blockers prevent planning.
 * An unclassified bump (null) yields the MAJOR candidate, never a silently low MINOR; it is only ever a preview label.
 */
export function provisionalLabel(analysis: EventPublishAnalysis): string {
  if (analysis.isFirstPublish || !analysis.candidateLabels) return analysis.initialLabel;
  return analysis.candidateLabels[analysis.suggestedBump ?? "MAJOR"];
}
