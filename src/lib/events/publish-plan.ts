import { ok, err, type Result } from "@/types/result";
import type { BumpKind, ChangeKind, VersionNumber } from "@/lib/entity-versioning/types";
import { INITIAL_VERSION, formatVersionLabel, nextVersionNumber, resolveBump } from "@/lib/entity-versioning/version-math";
import type { Diagnostic } from "@/lib/event-specs/types";
import { classifyEventSpecBump, classifyMessageBump, findUnresolvedMessageVersions, stableStringify, type BumpDecision, type EventSpecBumpSide } from "./bump-rules";
import type { FrozenChannel, FrozenTrait, MessageResolvedSpec, MessageSpec, PinRole, ResolvedPin } from "./types";

export type EventPublishBlockerKind =
  | "NO_CHANGES" | "UNPUBLISHED_PIN" | "MISSING_ENTITY" | "MISSING_TRAIT" | "INVALID_SPEC"
  | "NAME_CONFLICT" | "UNPUBLISHED_MESSAGE" | "UNRESOLVED_REFERENCE" | "VALIDATION_ERROR";

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

// ── Message ────────────────────────────────────────────────────────────────

export interface PinState {
  role: PinRole;
  entityId: string;
  /** null = the entity no longer exists. */
  entityName: string | null;
  /** The pinned published version; null = unpinned. */
  version: { id: string; label: string; major: number } | null;
  /** The entity's latest published version, for the message text. */
  latestLabel: string | null;
}

export interface MessagePublishState {
  name: string;
  hasUnpublishedChanges: boolean;
  spec: MessageSpec;
  /** Roles in use only (payload always). */
  pins: PinState[];
  missingTraitIds: string[];
  traitNames: Record<string, string>;
  specProblems: string[];
  nameConflict: string | null;
  latest: (LatestVersion & { resolved: MessageResolvedSpec }) | null;
}

const ROLE_LABEL: Record<PinRole, string> = { payload: "Payload", headers: "Headers", key: "Kafka key" };

export function messagePublishInput(state: MessagePublishState): { input: VersionedPublishInput; resolved: MessageResolvedSpec | null } {
  const blockers: EventPublishBlocker[] = [];
  const pins: Partial<Record<PinRole, ResolvedPin>> = {};
  if (!state.pins.some((pin) => pin.role === "payload")) blockers.push({ kind: "MISSING_ENTITY", message: "Payload is required" });
  for (const pin of state.pins) {
    const label = ROLE_LABEL[pin.role];
    if (pin.entityName === null) blockers.push({ kind: "MISSING_ENTITY", message: `${label} entity "${pin.entityId}" no longer exists` });
    else if (!pin.version) {
      blockers.push({
        kind: "UNPUBLISHED_PIN",
        message: pin.latestLabel
          ? `${label}: pick a published version of ${pin.entityName} (latest is v${pin.latestLabel})`
          : `${label}: publish ${pin.entityName} first, then pin its version`,
      });
    } else {
      pins[pin.role] = { entityId: pin.entityId, entityName: pin.entityName, entityVersionId: pin.version.id, label: pin.version.label, major: pin.version.major };
    }
  }
  for (const id of state.missingTraitIds) blockers.push({ kind: "MISSING_TRAIT", message: `Trait "${id}" no longer exists or is not a MESSAGE trait` });
  for (const p of state.specProblems) blockers.push({ kind: "INVALID_SPEC", message: p });
  if (state.nameConflict) blockers.push({ kind: "NAME_CONFLICT", message: state.nameConflict });

  const pinsResolved = !blockers.some((b) => b.kind === "UNPUBLISHED_PIN" || b.kind === "MISSING_ENTITY");
  const resolved: MessageResolvedSpec | null =
    pins.payload && pinsResolved
      ? { name: state.name, spec: structuredClone(state.spec), payload: pins.payload, headers: pins.headers ?? null, key: pins.key ?? null }
      : null;
  const bump = state.latest && resolved ? classifyMessageBump(state.latest.resolved, resolved, state.traitNames) : null;
  const latest = state.latest ? { major: state.latest.major, minor: state.latest.minor, sequence: state.latest.sequence } : null;
  return { input: { latest, hasChanges: state.hasUnpublishedChanges, blockers, bump }, resolved };
}

// ── Event Spec ─────────────────────────────────────────────────────────────

/** The channels and traits an Event Spec depends on, in first-reference order. */
export interface CatalogCopies {
  channels: FrozenChannel[];
  traits: FrozenTrait[];
}

/**
 * D8: the live Channel / Trait rows differ from the copies frozen into the latest version (ANY difference, key order aside).
 * One definition for the publish planner's `hasChanges` and for the "unpublished changes" badges, so they cannot disagree.
 */
export function hasCatalogDrift(frozen: CatalogCopies, live: CatalogCopies): boolean {
  return stableStringify(frozen.channels) !== stableStringify(live.channels) || stableStringify(frozen.traits) !== stableStringify(live.traits);
}

export interface EventSpecPublishFacts {
  latest: LatestVersion | null;
  /** D8: draft dirty or live channels / traits differ from the frozen copies. */
  hasChanges: boolean;
  previous: EventSpecBumpSide | null;
  current: EventSpecBumpSide;
  unresolved: Array<{ pointer: string; message: string }>;
  unpublishedMessages: Array<{ id: string; name: string }>;
  /**
   * Referenced traits whose headers entity is not pinned to a published version. The renderer would render the entity's mutable
   * draft and freeze it unpinned (no version to record, later edits would not register), so each one blocks like an unpinned
   * message pin. Optional so callers that have no traits can omit it.
   */
  unpinnedTraitHeaders?: Array<{ id: string; name: string }>;
  diagnostics: Diagnostic[];
  nameConflict: string | null;
}

const MAX_DIAGNOSTIC_BLOCKERS = 20;

export function eventSpecPublishInput(facts: EventSpecPublishFacts): VersionedPublishInput {
  const blockers: EventPublishBlocker[] = [];
  for (const p of facts.unresolved) blockers.push({ kind: "UNRESOLVED_REFERENCE", message: p.message, pointer: p.pointer });
  // Message-version ids the bump rules cannot interpret (the resolver may already have reported the current-side ones).
  const draftIds = new Set(facts.unpublishedMessages.map((m) => m.id));
  const reportedPointers = new Set(facts.unresolved.map((p) => p.pointer));
  for (const u of findUnresolvedMessageVersions(facts.previous, facts.current, draftIds)) {
    if (u.side === "previous") {
      blockers.push({
        kind: "UNRESOLVED_REFERENCE",
        message: `The latest published version references message version "${u.id}" in "${u.operation}", which cannot be resolved`,
      });
    } else if (!reportedPointers.has(u.pointer)) {
      blockers.push({ kind: "UNRESOLVED_REFERENCE", message: `Message version "${u.id}" in "${u.operation}" not found`, pointer: u.pointer });
    }
  }
  for (const m of facts.unpublishedMessages) {
    blockers.push({ kind: "UNPUBLISHED_MESSAGE", message: `Message ${m.name} is an unpublished draft — publish it and pick its version` });
  }
  for (const t of facts.unpinnedTraitHeaders ?? []) {
    blockers.push({
      kind: "UNPUBLISHED_PIN",
      message: `Trait ${t.name}: its headers entity is not pinned to a published version — pin a published entity version on the trait, then publish again`,
    });
  }
  const errors = facts.diagnostics.filter((d) => d.severity === "error");
  for (const d of errors.slice(0, MAX_DIAGNOSTIC_BLOCKERS)) blockers.push({ kind: "VALIDATION_ERROR", message: `${d.code}: ${d.message}`, pointer: d.pointer });
  if (errors.length > MAX_DIAGNOSTIC_BLOCKERS) {
    blockers.push({ kind: "VALIDATION_ERROR", message: `…and ${errors.length - MAX_DIAGNOSTIC_BLOCKERS} more validation error(s)` });
  }
  if (facts.nameConflict) blockers.push({ kind: "NAME_CONFLICT", message: facts.nameConflict });
  let bump: BumpDecision | null = null;
  if (facts.previous) {
    const decision = classifyEventSpecBump(facts.previous, facts.current, { draftMessageIds: draftIds });
    // Draft messages have no version yet, so only a definite MAJOR is reported; MINOR stays pending until they are published.
    bump = draftIds.size > 0 && decision.bump === "MINOR" ? null : decision;
  }
  return { latest: facts.latest ? { ...facts.latest } : null, hasChanges: facts.hasChanges, blockers, bump };
}
