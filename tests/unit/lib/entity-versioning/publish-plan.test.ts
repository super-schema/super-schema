import { describe, it, expect } from "vitest";
import { analyzePublish, needsReferenceOf, planPromote, planPublish, type PublishState } from "@/lib/entity-versioning/publish-plan";
import type { FieldSnapshot } from "@/services/version-history/version.types";

function f(name: string, extra: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return {
    id: `id-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
    fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0,
    ...extra,
  };
}

const ID = f("id", { nullable: false, isKey: true });
const EMAIL = f("email");
const ENTITY: PublishState["entity"] = {
  id: "order", name: "Order", status: "DRAFT", version: 1, hasUnpublishedChanges: true, typespecSource: "model Order {}",
};

function state(overrides: Partial<PublishState> = {}): PublishState {
  return { entity: ENTITY, latestRelease: null, openSnapshot: null, currentFields: [ID], references: [], ...overrides };
}

const published = (fields: FieldSnapshot[]) => ({ id: "v-5", major: 2, minor: 1, patch: 0, sequence: 5, fieldSnapshot: fields });

describe("first publish", () => {
  it("is 1.0.0 INITIAL with sequence mirroring Entity.version", () => {
    expect(planPublish(state())).toEqual({
      success: true,
      data: {
        mode: "CREATE", snapshotId: null, version: { major: 1, minor: 0, patch: 0 }, label: "1.0.0_snapshot", sequence: 1,
        changeKind: "INITIAL", pins: [], referencedVersions: [],
      },
    });
    const legacy = planPublish(state({ entity: { ...ENTITY, version: 4 } }));
    expect(legacy.success && legacy.data.sequence).toBe(4);
  });

  it("ignores a requested bump", () => {
    const res = planPublish(state(), "MAJOR");
    expect(res.success && res.data.label).toBe("1.0.0_snapshot");
  });

  it("offers only the initial label", () => {
    expect(analyzePublish(state())).toMatchObject({
      isFirstPublish: true, latestLabel: null, openSnapshotLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0.0_snapshot", blockers: [],
    });
  });
});

describe("later publishes", () => {
  it("suggests MINOR for an additive change and allows raising to MAJOR", () => {
    const s = state({ latestRelease: published([ID]), currentFields: [ID, EMAIL] });
    expect(analyzePublish(s)).toMatchObject({
      isFirstPublish: false, suggestedBump: "MINOR", latestLabel: "2.1.0", openSnapshotLabel: null,
      candidateLabels: { PATCH: "2.1.1_snapshot", MINOR: "2.2.0_snapshot", MAJOR: "3.0.0_snapshot" },
    });
    expect(planPublish(s)).toMatchObject({ success: true, data: { mode: "CREATE", label: "2.2.0_snapshot", changeKind: "MINOR", sequence: 6 } });
    expect(planPublish(s, "MAJOR")).toMatchObject({ success: true, data: { label: "3.0.0_snapshot", changeKind: "MAJOR", sequence: 6 } });
  });

  it("suggests MAJOR for a breaking change and refuses MINOR", () => {
    const s = state({ latestRelease: published([ID, EMAIL]), currentFields: [ID] });
    expect(analyzePublish(s).suggestedBump).toBe("MAJOR");
    const low = planPublish(s, "MINOR");
    expect(!low.success && low.error.code).toBe("BUMP_TOO_LOW");
    expect(planPublish(s)).toMatchObject({ success: true, data: { label: "3.0.0_snapshot", changeKind: "MAJOR" } });
  });
});

describe("blockers and pins", () => {
  it("blocks when nothing changed since the latest version", () => {
    const s = state({ latestRelease: published([ID]), entity: { ...ENTITY, hasUnpublishedChanges: false } });
    expect(analyzePublish(s).blockers).toEqual([{ kind: "NO_CHANGES", message: "No unpublished changes since v2.1.0." }]);
  });

  it("reports every blocker together", () => {
    const s = state({
      entity: { ...ENTITY, status: "RETIRED" },
      references: [
        { entityId: "cust", entityName: "Customer", latestVersionId: null },
        { entityId: "gone", entityName: null, latestVersionId: null },
        { entityId: "addr", entityName: "Address", latestVersionId: "v-addr-3" },
      ],
    });
    const analysis = analyzePublish(s);
    expect(analysis.blockers.map((b) => b.kind)).toEqual(["RETIRED", "UNPUBLISHED_REFERENCE", "MISSING_REFERENCE"]);
    expect(analysis.pins).toEqual([{ entityId: "addr", entityName: "Address", versionId: "v-addr-3" }]);

    const res = planPublish(s);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("PUBLISH_BLOCKED");
      expect(res.error.message).toContain("Publish Customer first");
      expect((res.error.details as { blockers: unknown[] }).blockers).toHaveLength(3);
    }
  });

  it("pins the latest published version of each referenced entity", () => {
    const s = state({ references: [{ entityId: "addr", entityName: "Address", latestVersionId: "v-addr-3" }] });
    expect(planPublish(s)).toMatchObject({
      success: true,
      data: { pins: [{ entityId: "addr", entityName: "Address", versionId: "v-addr-3" }] },
    });
  });
});

describe("the reference closure (Task 8)", () => {
  const cust = { code: "NEVER_PUBLISHED" as const, entityId: "cust", message: "Publish Customer first: sales / orders / Customer has never been published." };

  it("a closure blocker (a member never published, a pin that is gone) blocks the publish and its message reaches the error", () => {
    const s = state({ closureBlocker: { code: "PIN_NOT_FOUND", entityId: "addr", message: 'Field "addr" pins version 9.9 of sales / orders / Address, which does not exist.' } });
    expect(analyzePublish(s).blockers).toEqual([{ kind: "CLOSURE_BLOCKED", code: "PIN_NOT_FOUND", entityId: "addr", message: expect.stringContaining("9.9") }]);
    const res = planPublish(s);
    expect(!res.success && res.error.code).toBe("PUBLISH_BLOCKED");
    expect(!res.success && res.error.message).toContain("sales / orders / Address");
  });

  it("a transitive member the direct references do not mention is reported", () => {
    const s = state({
      references: [{ entityId: "addr", entityName: "Address", latestVersionId: "v-addr-3" }],
      closureBlocker: { ...cust, entityId: "deep" },
    });
    expect(analyzePublish(s).blockers.map((b) => b.kind)).toEqual(["CLOSURE_BLOCKED"]);
  });

  it("an entity already blocked as an unpublished direct reference is not reported twice", () => {
    const s = state({
      references: [{ entityId: "cust", entityName: "Customer", latestVersionId: null }],
      closureBlocker: cust,
    });
    expect(analyzePublish(s).blockers).toEqual([
      { kind: "UNPUBLISHED_REFERENCE", entityId: "cust", entityName: "Customer", message: "Publish Customer first" },
    ]);
  });

  it("an ambiguous reference (no single entity to name) is never dropped as a duplicate", () => {
    const s = state({
      references: [{ entityId: "cust", entityName: "Customer", latestVersionId: null }],
      closureBlocker: { code: "AMBIGUOUS_REFERENCE", entityId: "cust", message: "Field x refers to Address, which matches 2 entities." },
    });
    expect(analyzePublish(s).blockers.map((b) => b.kind)).toEqual(["UNPUBLISHED_REFERENCE", "CLOSURE_BLOCKED"]);
  });

  describe("an ambiguous reference stays structured (for the pick dialog)", () => {
    const candidates = [
      { entityId: "x1", domain: "d1", product: "p1", entity: "Address" },
      { entityId: "x2", domain: "d2", product: "p2", entity: "Address" },
    ];
    const details = { field: "addr", name: "Address", candidates, entityId: "cust", fieldId: "cust.addr" };
    const ambiguous = { code: "AMBIGUOUS_REFERENCE", message: "Field addr refers to Address, which matches 2 entities.", details };

    it("keeps the details on the blocker, in the analysis and in the plan's error", () => {
      const s = state({ closureBlocker: ambiguous });
      expect(analyzePublish(s).blockers).toEqual([{ kind: "CLOSURE_BLOCKED", code: "AMBIGUOUS_REFERENCE", message: ambiguous.message, details }]);
      const res = planPublish(s);
      expect(!res.success && (res.error.details as { blockers: unknown[] }).blockers).toEqual([
        { kind: "CLOSURE_BLOCKED", code: "AMBIGUOUS_REFERENCE", message: ambiguous.message, details },
      ]);
    });

    it("needsReferenceOf reads the pick the blocker asks for, in generateSchemaAction's needsReference shape", () => {
      expect(needsReferenceOf(analyzePublish(state({ closureBlocker: ambiguous })).blockers)).toEqual(details);
    });

    it("needsReferenceOf is undefined for every other blocker, and for a malformed one", () => {
      expect(needsReferenceOf(analyzePublish(state({ closureBlocker: { code: "NEVER_PUBLISHED", entityId: "x", message: "m", details: { ref: {} } } })).blockers)).toBeUndefined();
      expect(needsReferenceOf(analyzePublish(state({ entity: { ...ENTITY, status: "RETIRED" } })).blockers)).toBeUndefined();
      expect(needsReferenceOf([{ kind: "CLOSURE_BLOCKED", code: "AMBIGUOUS_REFERENCE", message: "m" }])).toBeUndefined();
      expect(needsReferenceOf([{ kind: "CLOSURE_BLOCKED", code: "AMBIGUOUS_REFERENCE", message: "m", details: { field: "f", name: 3, candidates: "x", entityId: "e", fieldId: "i" } }])).toBeUndefined();
    });

    it("needsReferenceOf asks for no pick when the ambiguous name sits in a frozen snapshot (a pick cannot change a published version)", () => {
      const frozen = { code: "AMBIGUOUS_REFERENCE", message: 'This published version of Y refers to "Address" by name', details: { ...details, frozen: true } };
      const blockers = analyzePublish(state({ closureBlocker: frozen })).blockers;
      expect(blockers).toEqual([expect.objectContaining({ kind: "CLOSURE_BLOCKED", code: "AMBIGUOUS_REFERENCE", message: frozen.message })]);
      expect(needsReferenceOf(blockers)).toBeUndefined();
      // a later, askable ambiguity is still found
      expect(needsReferenceOf([...blockers, ...analyzePublish(state({ closureBlocker: ambiguous })).blockers])).toEqual(details);
    });

    it("needsReferenceOf reads it from a plan error's details too", () => {
      const res = planPublish(state({ closureBlocker: ambiguous }));
      expect(!res.success && needsReferenceOf((res.error.details as { blockers: never[] }).blockers)).toEqual(details);
    });
  });

  it("the plan carries the referenced versions the closure used, unchanged", () => {
    const referencedVersions = [
      { ref: { entityId: "b", domain: "d", product: "p", entity: "B" }, version: "1.2", pinned: false },
      { ref: { entityId: "c", domain: "d", product: "p", entity: "C" }, version: "1.0", pinned: true },
    ];
    expect(planPublish(state({ referencedVersions }))).toMatchObject({ success: true, data: { referencedVersions } });
    expect(planPublish(state({ latestRelease: published([ID]), currentFields: [ID, EMAIL], referencedVersions }))).toMatchObject({
      success: true,
      data: { referencedVersions },
    });
  });
});

describe("unresolved reference names", () => {
  it("are a warning, not a blocker", () => {
    const s = state({ unresolvedReferenceNames: ["Ghost", "Phantom"] });
    const analysis = analyzePublish(s);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.warnings).toEqual([
      {
        kind: "UNRESOLVED_REFERENCE",
        entityName: "Ghost",
        message: 'Reference "Ghost" does not match any entity in this line; it will not be pinned.',
      },
      {
        kind: "UNRESOLVED_REFERENCE",
        entityName: "Phantom",
        message: 'Reference "Phantom" does not match any entity in this line; it will not be pinned.',
      },
    ]);
    expect(planPublish(s).success).toBe(true);
  });

  it("no warnings when every reference resolved", () => {
    expect(analyzePublish(state()).warnings).toEqual([]);
  });
});

describe("snapshot saves (phase 1)", () => {
  const release = (major: number, minor: number, fields: FieldSnapshot[], sequence = 1) => ({
    id: `rel-${major}.${minor}`, major, minor, patch: 0, sequence, fieldSnapshot: fields,
  });
  const snapshot = (major: number, minor: number, sequence = 2) => ({ id: "snap-1", major, minor, patch: 0, sequence });

  it("first save creates 1.0.0_snapshot", () => {
    expect(planPublish(state())).toMatchObject({
      success: true,
      data: { mode: "CREATE", snapshotId: null, label: "1.0.0_snapshot", version: { major: 1, minor: 0, patch: 0 }, changeKind: "INITIAL" },
    });
  });

  it("after 1.0.0 release a MINOR change creates 1.1.0_snapshot", () => {
    const s = state({ latestRelease: release(1, 0, [ID]), currentFields: [ID, EMAIL] });
    expect(analyzePublish(s)).toMatchObject({ suggestedBump: "MINOR", latestLabel: "1.0.0", openSnapshotLabel: null });
    expect(planPublish(s)).toMatchObject({
      success: true,
      data: { mode: "CREATE", snapshotId: null, label: "1.1.0_snapshot", changeKind: "MINOR", sequence: 2 },
    });
  });

  it("second save updates the open snapshot in place", () => {
    const s = state({ latestRelease: release(1, 0, [ID]), openSnapshot: snapshot(1, 1), currentFields: [ID, EMAIL] });
    expect(analyzePublish(s)).toMatchObject({ openSnapshotLabel: "1.1.0_snapshot", candidateLabels: { PATCH: "1.1.0_snapshot", MINOR: "1.1.0_snapshot", MAJOR: "2.0.0_snapshot" } });
    expect(planPublish(s)).toMatchObject({
      success: true,
      data: { mode: "UPDATE", snapshotId: "snap-1", label: "1.1.0_snapshot", version: { major: 1, minor: 1, patch: 0 }, changeKind: "MINOR", sequence: 2 },
    });
  });

  it("a save before any release updates the open 1.0.0_snapshot, whatever bump is asked", () => {
    const s = state({ openSnapshot: { id: "snap-0", major: 1, minor: 0, patch: 0, sequence: 1 } });
    expect(analyzePublish(s)).toMatchObject({ isFirstPublish: true, openSnapshotLabel: "1.0.0_snapshot" });
    expect(planPublish(s, "MAJOR")).toMatchObject({
      success: true,
      data: { mode: "UPDATE", snapshotId: "snap-0", label: "1.0.0_snapshot", changeKind: "INITIAL", sequence: 1 },
    });
  });

  it("breaking save raises 1.1.0_snapshot to 2.0.0_snapshot", () => {
    const s = state({ latestRelease: release(1, 0, [ID, EMAIL]), openSnapshot: snapshot(1, 1), currentFields: [ID] });
    expect(planPublish(s)).toMatchObject({
      success: true,
      data: { mode: "UPDATE", snapshotId: "snap-1", label: "2.0.0_snapshot", version: { major: 2, minor: 0, patch: 0 }, changeKind: "MAJOR" },
    });
  });

  it("a later non-breaking save keeps 2.0.0_snapshot", () => {
    const s = state({ latestRelease: release(1, 0, [ID]), openSnapshot: snapshot(2, 0), currentFields: [ID, EMAIL] });
    expect(analyzePublish(s).suggestedBump).toBe("MINOR");
    expect(planPublish(s)).toMatchObject({
      success: true,
      data: { mode: "UPDATE", snapshotId: "snap-1", label: "2.0.0_snapshot", version: { major: 2, minor: 0, patch: 0 }, changeKind: "MAJOR" },
    });
  });

  it("a raised 2.0.0_snapshot is what a MINOR or PATCH save shows too (never lowered)", () => {
    const s = state({ latestRelease: release(1, 0, [ID]), openSnapshot: snapshot(2, 0), currentFields: [ID, EMAIL] });
    expect(analyzePublish(s).candidateLabels).toEqual({ PATCH: "2.0.0_snapshot", MINOR: "2.0.0_snapshot", MAJOR: "2.0.0_snapshot" });
  });

  it("a snapshot not above the latest release is raised past it", () => {
    const s = state({ latestRelease: release(1, 1, [ID]), openSnapshot: snapshot(1, 1), currentFields: [ID, EMAIL] });
    expect(planPublish(s)).toMatchObject({ success: true, data: { mode: "UPDATE", label: "1.2.0_snapshot" } });
  });

  it("still refuses a bump below the suggestion while a snapshot is open", () => {
    const s = state({ latestRelease: release(1, 0, [ID, EMAIL]), openSnapshot: snapshot(2, 0), currentFields: [ID] });
    const res = planPublish(s, "MINOR");
    expect(!res.success && res.error.code).toBe("BUMP_TOO_LOW");
  });

  it("no changes since the open snapshot blocks the save, naming the snapshot", () => {
    const s = state({ latestRelease: release(1, 0, [ID]), openSnapshot: snapshot(1, 1), entity: { ...ENTITY, hasUnpublishedChanges: false } });
    expect(analyzePublish(s).blockers).toEqual([{ kind: "NO_CHANGES", message: "No unsaved changes since v1.1.0_snapshot." }]);
  });
});

describe("analyzePublish: a reference changed since the open snapshot was saved", () => {
  it("is something to save: no NO_CHANGES with a clean draft", () => {
    const s = state({
      entity: { ...state().entity, hasUnpublishedChanges: false },
      latestRelease: null,
      openSnapshot: { id: "snap-1", major: 1, minor: 0, patch: 0, sequence: 1 },
      changedReferences: ["Customer"],
    });
    expect(analyzePublish(s).blockers).toEqual([]);
    expect(planPublish(s)).toMatchObject({ success: true, data: { mode: "UPDATE", snapshotId: "snap-1" } });
  });
});

describe("planPromote", () => {
  const base = (overrides: Partial<PublishState> = {}) => ({
    ...state({
      latestRelease: { id: "rel", major: 1, minor: 0, patch: 0, sequence: 1, fieldSnapshot: [ID] },
      openSnapshot: { id: "snap-1", major: 1, minor: 1, patch: 0, sequence: 2 },
      ...overrides,
    }),
    draftDirty: false,
    snapshotReferences: [] as string[],
  });

  it("promotes a clean snapshot to its release label", () => {
    expect(planPromote(base())).toEqual({ success: true, data: { snapshotId: "snap-1", label: "1.1.0" } });
  });

  it("promote refuses a dirty draft", () => {
    const res = planPromote({ ...base(), draftDirty: true });
    expect(!res.success && res.error.code).toBe("DRAFT_NOT_SAVED");
  });

  it("promote refuses snapshot references", () => {
    const res = planPromote({ ...base(), snapshotReferences: ["Customer", "Address"] });
    expect(!res.success && res.error.code).toBe("SNAPSHOT_REFERENCES");
    expect(!res.success && res.error.message).toContain("Customer");
    expect(!res.success && res.error.message).toContain("Address");
  });

  it("promote names what changed since the snapshot was saved, with the fix that needs (save again), apart from snapshot references", () => {
    const changed = planPromote({ ...base(), changedReferences: ["Customer"] });
    expect(changed).toMatchObject({
      success: false,
      error: {
        code: "SNAPSHOT_REFERENCES", message: "Customer changed since v1.1.0_snapshot was saved.", suggestedFix: "Save the snapshot again, then promote.",
        details: { entities: ["Customer"], snapshots: [], changed: ["Customer"] },
      },
    });
    const both = planPromote({ ...base(), snapshotReferences: ["Address"], changedReferences: ["Customer"] });
    expect(!both.success && both.error.message).toBe(
      "v1.1.0_snapshot references snapshot versions of Address; a release may only reference released versions. Customer changed since v1.1.0_snapshot was saved."
    );
    expect(!both.success && both.error.suggestedFix).toBe("Promote those first, then promote this one. Save the snapshot again, then promote.");
  });

  it("promote without snapshot fails", () => {
    const res = planPromote(base({ openSnapshot: null }));
    expect(!res.success && res.error.code).toBe("NO_SNAPSHOT");
  });

  it("promote refuses a snapshot whose number is not above the latest release", () => {
    const res = planPromote(base({ openSnapshot: { id: "snap-1", major: 1, minor: 0, patch: 0, sequence: 2 } }));
    expect(!res.success && res.error.code).toBe("SNAPSHOT_NOT_AHEAD");
  });
});
