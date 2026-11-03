import { ok, err, type Result } from "@/types/result";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import { suggestBump } from "./bump-suggestion";
import { INITIAL_VERSION, changeKindFrom, compareVersions, formatVersionLabel, resolveBump, snapshotVersionNumber as snapshotNumber } from "./version-math";
import type { BumpKind, ChangeKind, VersionNumber } from "./types";
import type { ReferencedVersion } from "./referenced-versions";
import type { EntityRef } from "@/lib/references/entity-reference";

export interface PublishState {
  entity: {
    id: string;
    name: string;
    status: string;
    version: number;
    hasUnpublishedChanges: boolean;
    typespecSource: string | null;
  };
  /**
   * The latest RELEASED version: new snapshot numbers are counted from it and the bump is suggested from the diff against its fields.
   * `fieldSnapshot` (and `id`) are what the diff needs on top of the number.
   */
  latestRelease: (VersionNumber & { id: string; sequence: number; fieldSnapshot: FieldSnapshot[] }) | null;
  /** The entity's one open (mutable) snapshot, if any: a save updates it in place instead of creating a version. */
  openSnapshot: (VersionNumber & { id: string; sequence: number }) | null;
  currentFields: FieldSnapshot[];
  /** One entry per referenced entity; `entityName: null` means it no longer exists. */
  references: Array<{ entityId: string; entityName: string | null; latestVersionId: string | null }>;
  /** By-name references that match no entity in the entity's line — not pinned, surfaced as warnings. */
  unresolvedReferenceNames?: string[];
  /**
   * What the REAL reference closure says (`loadPublishClosure`: the entity at its saved rows, everything it references, transitively,
   * at its latest published version or pin): why it cannot be published against, if so. `entityId` is the entity the message is about.
   */
  closureBlocker?: { code: string; message: string; entityId?: string; details?: object };
  /** The version of every referenced entity the closure used, to record on the published version (empty: references nothing). */
  referencedVersions?: ReferencedVersion[];
  /**
   * Entities the open snapshot references that were saved again after it was saved (a snapshot updated in place): the snapshot no
   * longer holds what it was checked against, so a save is possible (no NO_CHANGES) even with a clean draft.
   */
  changedReferences?: string[];
}

export type PublishBlocker =
  | { kind: "RETIRED"; message: string }
  | { kind: "NO_CHANGES"; message: string }
  | { kind: "UNPUBLISHED_REFERENCE"; entityId: string; entityName: string; message: string }
  | { kind: "MISSING_REFERENCE"; entityId: string; message: string }
  | { kind: "CLOSURE_BLOCKED"; code: string; message: string; entityId?: string; details?: object };

/**
 * The pick an ambiguous bare-name reference asks for, in the shape `generateSchemaAction` answers (`needsReference`): the field and
 * the name it refers to, the entities that name matches, and the entity + field row that HOLD the reference (a member of the closure as
 * often as the entity itself), which is where `setFieldReferenceAction(entityId, fieldId, ...)` writes the pick.
 */
export interface PublishNeedsReference {
  field: string;
  name: string;
  candidates: EntityRef[];
  entityId: string;
  fieldId: string;
}

/**
 * The pick the publish is blocked on, if an ambiguous reference blocks it (the first one): read from the blockers of a preview or of a
 * refused publish's `details.blockers`, so the UI can open the pick dialog instead of showing a sentence. Tolerant of anything else:
 * a blocker of another kind or code, or `details` that are not the expected shape, read as no pick.
 */
export function needsReferenceOf(blockers: ReadonlyArray<PublishBlocker>): PublishNeedsReference | undefined {
  for (const blocker of blockers) {
    if (blocker.kind !== "CLOSURE_BLOCKED" || blocker.code !== "AMBIGUOUS_REFERENCE") continue;
    const d = blocker.details as (Partial<Record<keyof PublishNeedsReference, unknown>> & { frozen?: unknown }) | undefined;
    // A name frozen in a published or pinned snapshot cannot be settled by a pick (the owner has to be published again): no dialog.
    if (d && d.frozen === true) continue;
    if (
      d &&
      typeof d.field === "string" &&
      typeof d.name === "string" &&
      Array.isArray(d.candidates) &&
      typeof d.entityId === "string" &&
      typeof d.fieldId === "string"
    ) {
      return { field: d.field, name: d.name, candidates: d.candidates as EntityRef[], entityId: d.entityId, fieldId: d.fieldId };
    }
  }
  return undefined;
}

/** Shown in the publish dialog; never stops the publish. */
export type PublishWarning = { kind: "UNRESOLVED_REFERENCE"; entityName: string; message: string };

export interface ReferencePin {
  entityId: string;
  entityName: string;
  versionId: string;
}

export interface PublishAnalysis {
  /** Nothing released yet: the snapshot is 1.0.0_snapshot whatever the bump. */
  isFirstPublish: boolean;
  /** The latest released label ("2.1.0"), null before the first release. */
  latestLabel: string | null;
  /** The open snapshot's label ("2.2.0_snapshot"), null when none is open. */
  openSnapshotLabel: string | null;
  /** Suggested from the diff against the latest release; null before the first release (always 1.0.0). */
  suggestedBump: BumpKind | null;
  /** The snapshot label a save at each bump would produce (an open snapshot is never lowered); null before the first release. */
  candidateLabels: Record<BumpKind, string> | null;
  /** The first save's label ("1.0.0_snapshot"). */
  initialLabel: string;
  reasons: string[];
  diffSummary: { added: number; removed: number; modified: number };
  blockers: PublishBlocker[];
  warnings: PublishWarning[];
  pins: ReferencePin[];
}

export interface PublishPlan {
  /** CREATE a new snapshot row, or UPDATE the open one (`snapshotId`) in place, possibly at a raised number. */
  mode: "CREATE" | "UPDATE";
  /** The open snapshot an UPDATE writes; null for CREATE. */
  snapshotId: string | null;
  version: VersionNumber;
  /** The snapshot label, e.g. "2.2.0_snapshot". */
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  pins: ReferencePin[];
  /** What the version records about the entities it used: stored with the version, read back for staleness. */
  referencedVersions: ReferencedVersion[];
}

/** Everything the publish dialog shows. Never fails — blockers are data. */
export function analyzePublish(state: PublishState): PublishAnalysis {
  const { entity, latestRelease, openSnapshot } = state;
  const blockers: PublishBlocker[] = [];

  if (entity.status === "RETIRED") {
    blockers.push({ kind: "RETIRED", message: "Retired entities are read-only and cannot be published." });
  }
  if (!entity.hasUnpublishedChanges && (state.changedReferences ?? []).length === 0) {
    if (openSnapshot) {
      blockers.push({ kind: "NO_CHANGES", message: `No unsaved changes since v${formatVersionLabel(openSnapshot, "SNAPSHOT")}.` });
    } else if (latestRelease) {
      blockers.push({ kind: "NO_CHANGES", message: `No unpublished changes since v${formatVersionLabel(latestRelease)}.` });
    }
  }

  const pins: ReferencePin[] = [];
  for (const ref of state.references) {
    if (ref.entityName === null) {
      blockers.push({
        kind: "MISSING_REFERENCE",
        entityId: ref.entityId,
        message: `A reference field points at entity "${ref.entityId}", which no longer exists.`,
      });
    } else if (ref.latestVersionId === null) {
      blockers.push({
        kind: "UNPUBLISHED_REFERENCE",
        entityId: ref.entityId,
        entityName: ref.entityName,
        message: `Publish ${ref.entityName} first`,
      });
    } else {
      pins.push({ entityId: ref.entityId, entityName: ref.entityName, versionId: ref.latestVersionId });
    }
  }

  // The closure sees what the direct references above cannot (an entity only reachable through a published one, a pin that is gone, an
  // ambiguous bare name). One it names that is already blocked above as an unpublished direct reference is not reported twice.
  const closure = state.closureBlocker;
  if (closure) {
    const alreadyBlocked =
      closure.code === "NEVER_PUBLISHED" &&
      closure.entityId !== undefined &&
      blockers.some((b) => b.kind === "UNPUBLISHED_REFERENCE" && b.entityId === closure.entityId);
    if (!alreadyBlocked) {
      blockers.push({
        kind: "CLOSURE_BLOCKED",
        code: closure.code,
        message: closure.message,
        ...(closure.entityId ? { entityId: closure.entityId } : {}),
        ...(closure.details ? { details: closure.details } : {}),
      });
    }
  }

  const warnings: PublishWarning[] = (state.unresolvedReferenceNames ?? []).map((entityName) => ({
    kind: "UNRESOLVED_REFERENCE",
    entityName,
    message: `Reference "${entityName}" does not match any entity in this line; it will not be pinned.`,
  }));

  // The first save's label, as the plan writes it: the first release comes from promoting it.
  const initialLabel = formatVersionLabel(INITIAL_VERSION, "SNAPSHOT");
  const openSnapshotLabel = openSnapshot ? formatVersionLabel(openSnapshot, "SNAPSHOT") : null;
  if (!latestRelease) {
    return {
      isFirstPublish: true,
      latestLabel: null,
      openSnapshotLabel,
      suggestedBump: null,
      candidateLabels: null,
      initialLabel,
      reasons: [],
      diffSummary: { added: state.currentFields.length, removed: 0, modified: 0 },
      blockers,
      warnings,
      pins,
    };
  }

  const suggestion = suggestBump(latestRelease.fieldSnapshot, state.currentFields);
  const candidate = (bump: BumpKind) => formatVersionLabel(snapshotNumber(latestRelease, openSnapshot, bump), "SNAPSHOT");
  return {
    isFirstPublish: false,
    latestLabel: formatVersionLabel(latestRelease),
    openSnapshotLabel,
    suggestedBump: suggestion.bump,
    candidateLabels: { MAJOR: candidate("MAJOR"), MINOR: candidate("MINOR"), PATCH: candidate("PATCH") },
    initialLabel,
    reasons: suggestion.reasons,
    diffSummary: suggestion.summary,
    blockers,
    warnings,
    pins,
  };
}

/**
 * The snapshot a save writes, or why it cannot (all blockers at once, spec §10): CREATE a snapshot when none is open, numbered from the
 * latest release; otherwise UPDATE the open one, raised when the resolved bump yields a higher number, never lowered.
 */
export function planPublish(state: PublishState, requested?: BumpKind): Result<PublishPlan> {
  const analysis = analyzePublish(state);
  if (analysis.blockers.length > 0) {
    return err({
      code: "PUBLISH_BLOCKED",
      message: analysis.blockers.map((b) => b.message).join("; "),
      details: { blockers: analysis.blockers },
      suggestedFix: "Resolve every blocker, then publish again.",
    });
  }

  const { latestRelease, openSnapshot, entity } = state;
  let bump: BumpKind = "MINOR";
  if (latestRelease) {
    const resolved = resolveBump(analysis.suggestedBump ?? "MINOR", requested);
    if (!resolved.success) return resolved;
    bump = resolved.data;
  }
  const version = snapshotNumber(latestRelease, openSnapshot, bump);
  const sequence = openSnapshot ? openSnapshot.sequence : latestRelease ? latestRelease.sequence + 1 : Math.max(entity.version, 1);
  return ok({
    mode: openSnapshot ? "UPDATE" : "CREATE",
    snapshotId: openSnapshot?.id ?? null,
    version,
    label: formatVersionLabel(version, "SNAPSHOT"),
    sequence,
    changeKind: changeKindFrom(version, latestRelease),
    pins: analysis.pins,
    referencedVersions: state.referencedVersions ?? [],
  });
}

/** What a promote is decided on; an entity's `PublishState` and an event's planner input both carry it. */
export interface PromoteState {
  latestRelease: VersionNumber | null;
  openSnapshot: (VersionNumber & { id: string }) | null;
  /** The draft has edits the snapshot does not hold (save first). */
  draftDirty: boolean;
  /** Names of what the snapshot references only at a snapshot (a release may only reference releases): promote those first. */
  snapshotReferences: string[];
  /** Names of what the snapshot references that was saved again after it was saved: save this snapshot again first. */
  changedReferences?: string[];
}

/**
 * Whether the open snapshot can be promoted to its release, and to which label (entities and events alike). `draftDirty`: the draft
 * has edits the snapshot does not hold (save first). `snapshotReferences` / `changedReferences`: what the snapshot references only at
 * a snapshot, or saved again since (SNAPSHOT_REFERENCES, the message saying which action each needs).
 */
export function planPromote(state: PromoteState): Result<{ snapshotId: string; label: string }> {
  const { openSnapshot, latestRelease } = state;
  if (!openSnapshot) {
    return err({ code: "NO_SNAPSHOT", message: "There is no snapshot to promote.", suggestedFix: "Save a snapshot first." });
  }
  const snapshotLabel = formatVersionLabel(openSnapshot, "SNAPSHOT");
  if (state.draftDirty) {
    return err({
      code: "DRAFT_NOT_SAVED",
      message: `The draft has changes that are not in v${snapshotLabel}.`,
      suggestedFix: "Save the draft to the snapshot, then promote.",
    });
  }
  const snapshots = state.snapshotReferences;
  const changed = state.changedReferences ?? [];
  if (snapshots.length > 0 || changed.length > 0) {
    const messages: string[] = [];
    const fixes: string[] = [];
    if (snapshots.length > 0) {
      messages.push(`v${snapshotLabel} references snapshot versions of ${snapshots.join(", ")}; a release may only reference released versions.`);
      fixes.push("Promote those first, then promote this one.");
    }
    if (changed.length > 0) {
      messages.push(`${changed.join(", ")} changed since v${snapshotLabel} was saved.`);
      fixes.push("Save the snapshot again, then promote.");
    }
    return err({
      code: "SNAPSHOT_REFERENCES",
      message: messages.join(" "),
      details: { entities: [...new Set([...snapshots, ...changed])].sort(), snapshots, changed },
      suggestedFix: fixes.join(" "),
    });
  }
  if (latestRelease && compareVersions(openSnapshot, latestRelease) <= 0) {
    return err({
      code: "SNAPSHOT_NOT_AHEAD",
      message: `v${snapshotLabel} is not above the latest release v${formatVersionLabel(latestRelease)}; released numbers are never reused.`,
      suggestedFix: "Save the snapshot again to renumber it, then promote.",
    });
  }
  return ok({ snapshotId: openSnapshot.id, label: formatVersionLabel(openSnapshot) });
}
