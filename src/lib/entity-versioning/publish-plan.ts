import { ok, err, type Result } from "@/types/result";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import { suggestBump } from "./bump-suggestion";
import { INITIAL_VERSION, formatVersionLabel, nextVersionNumber, resolveBump } from "./version-math";
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
  latest: { id: string; major: number; minor: number; sequence: number; fieldSnapshot: FieldSnapshot[] } | null;
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
    const d = blocker.details as Partial<Record<keyof PublishNeedsReference, unknown>> | undefined;
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
  isFirstPublish: boolean;
  latestLabel: string | null;
  /** null on a first publish (always 1.0). */
  suggestedBump: BumpKind | null;
  /** Next label per bump; null on a first publish. */
  candidateLabels: Record<BumpKind, string> | null;
  initialLabel: string;
  reasons: string[];
  diffSummary: { added: number; removed: number; modified: number };
  blockers: PublishBlocker[];
  warnings: PublishWarning[];
  pins: ReferencePin[];
}

export interface PublishPlan {
  version: VersionNumber;
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  pins: ReferencePin[];
  /** What the version records about the entities it used: stored with the version, read back for staleness. */
  referencedVersions: ReferencedVersion[];
}

/** Everything the publish dialog shows. Never fails — blockers are data. */
export function analyzePublish(state: PublishState): PublishAnalysis {
  const { entity, latest } = state;
  const blockers: PublishBlocker[] = [];

  if (entity.status === "RETIRED") {
    blockers.push({ kind: "RETIRED", message: "Retired entities are read-only and cannot be published." });
  }
  if (latest && !entity.hasUnpublishedChanges) {
    blockers.push({ kind: "NO_CHANGES", message: `No unpublished changes since v${formatVersionLabel(latest)}.` });
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

  const initialLabel = formatVersionLabel(INITIAL_VERSION);
  if (!latest) {
    return {
      isFirstPublish: true,
      latestLabel: null,
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

  const suggestion = suggestBump(latest.fieldSnapshot, state.currentFields);
  return {
    isFirstPublish: false,
    latestLabel: formatVersionLabel(latest),
    suggestedBump: suggestion.bump,
    candidateLabels: {
      MAJOR: formatVersionLabel(nextVersionNumber(latest, "MAJOR").version),
      MINOR: formatVersionLabel(nextVersionNumber(latest, "MINOR").version),
    },
    initialLabel,
    reasons: suggestion.reasons,
    diffSummary: suggestion.summary,
    blockers,
    warnings,
    pins,
  };
}

/** The version publishEntity will write, or why it cannot (all blockers at once, spec §10). */
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

  const { latest, entity } = state;
  const referencedVersions = state.referencedVersions ?? [];
  if (!latest) {
    const { version, changeKind } = nextVersionNumber(null, "MINOR");
    return ok({
      version,
      label: formatVersionLabel(version),
      sequence: Math.max(entity.version, 1),
      changeKind,
      pins: analysis.pins,
      referencedVersions,
    });
  }

  const bump = resolveBump(analysis.suggestedBump ?? "MINOR", requested);
  if (!bump.success) return bump;
  const { version, changeKind } = nextVersionNumber(latest, bump.data);
  return ok({
    version,
    label: formatVersionLabel(version),
    sequence: latest.sequence + 1,
    changeKind,
    pins: analysis.pins,
    referencedVersions,
  });
}
