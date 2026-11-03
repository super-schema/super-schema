import { describe, it, expect } from "vitest";
import { analyzeVersionedPublish, planVersionedPublish, provisionalLabel, type VersionedPublishInput } from "@/lib/events/publish-plan";

// The generic planner the event publish is built on (document/bump.ts feeds it the classification). A save writes the event's one open
// snapshot (`x.y.z_snapshot`): CREATE when none is open (numbered from the latest RELEASE), otherwise UPDATE it in place, raised, never lowered.

const release = { id: "rel-1", major: 1, minor: 3, patch: 0, sequence: 4 };
const input = (over: Partial<VersionedPublishInput> = {}): VersionedPublishInput => ({
  latestRelease: release, openSnapshot: null, hasChanges: true, blockers: [], bump: { bump: "MINOR", reasons: [] }, ...over,
});

describe("versioned publish planner: snapshot numbering", () => {
  it("first save creates 1.0.0_snapshot INITIAL at sequence 1", () => {
    const first = input({ latestRelease: null, bump: null });
    expect(analyzeVersionedPublish(first)).toMatchObject({
      isFirstPublish: true, initialLabel: "1.0.0_snapshot", candidateLabels: null, latestLabel: null, openSnapshotLabel: null,
    });
    expect(planVersionedPublish(first)).toEqual({
      success: true,
      data: { mode: "CREATE", snapshotId: null, version: { major: 1, minor: 0, patch: 0 }, label: "1.0.0_snapshot", sequence: 1, changeKind: "INITIAL", reasons: [] },
    });
  });

  it("a second save before any release updates the open 1.0.0_snapshot in place, whatever the bump", () => {
    const open = { id: "snap-1", major: 1, minor: 0, patch: 0, sequence: 1 };
    const r = planVersionedPublish(input({ latestRelease: null, openSnapshot: open, bump: null }), "MAJOR");
    expect(r).toMatchObject({ success: true, data: { mode: "UPDATE", snapshotId: "snap-1", label: "1.0.0_snapshot", sequence: 1, changeKind: "INITIAL" } });
  });

  it("a save after a release creates the next snapshot, numbered from the release", () => {
    expect(planVersionedPublish(input())).toMatchObject({
      success: true, data: { mode: "CREATE", snapshotId: null, label: "1.4.0_snapshot", sequence: 5, changeKind: "MINOR" },
    });
    expect(planVersionedPublish(input({ bump: { bump: "PATCH", reasons: ["Documentation changed"] } }))).toMatchObject({
      success: true, data: { label: "1.3.1_snapshot", changeKind: "PATCH", reasons: ["Documentation changed"] },
    });
    expect(analyzeVersionedPublish(input()).candidateLabels).toEqual({ MAJOR: "2.0.0_snapshot", MINOR: "1.4.0_snapshot", PATCH: "1.3.1_snapshot" });
  });

  it("raises the open snapshot in place, and never lowers it", () => {
    const open = { id: "snap-2", major: 1, minor: 4, patch: 0, sequence: 5 };
    const raised = planVersionedPublish(input({ openSnapshot: open, bump: { bump: "MAJOR", reasons: ["Trait removed"] } }));
    expect(raised).toMatchObject({ success: true, data: { mode: "UPDATE", snapshotId: "snap-2", label: "2.0.0_snapshot", sequence: 5, changeKind: "MAJOR" } });

    const high = { ...open, major: 2, minor: 0 };
    const kept = planVersionedPublish(input({ openSnapshot: high, bump: { bump: "PATCH", reasons: [] } }));
    expect(kept).toMatchObject({ success: true, data: { mode: "UPDATE", label: "2.0.0_snapshot", changeKind: "MAJOR" } });
    expect(analyzeVersionedPublish(input({ openSnapshot: high })).candidateLabels).toEqual({
      MAJOR: "2.0.0_snapshot", MINOR: "2.0.0_snapshot", PATCH: "2.0.0_snapshot",
    });
    expect(analyzeVersionedPublish(input({ openSnapshot: high })).openSnapshotLabel).toBe("2.0.0_snapshot");
  });

  it("a snapshot left at or below the latest release is renumbered above it (released numbers are never reused)", () => {
    const stale = { id: "snap-3", major: 1, minor: 3, patch: 0, sequence: 5 };
    expect(planVersionedPublish(input({ openSnapshot: stale }))).toMatchObject({ success: true, data: { mode: "UPDATE", label: "1.4.0_snapshot" } });
  });

  it("blocks with NO_CHANGES (first) plus every other blocker, all together; the message names the open snapshot when there is one", () => {
    const r = planVersionedPublish(input({ hasChanges: false, blockers: [{ kind: "NAME_CONFLICT", message: "taken" }] }));
    expect(!r.success && r.error.code).toBe("PUBLISH_BLOCKED");
    const blockers = !r.success ? (r.error.details as { blockers: Array<{ kind: string; message: string }> }).blockers : [];
    expect(blockers.map((b) => b.kind)).toEqual(["NO_CHANGES", "NAME_CONFLICT"]);
    expect(blockers[0].message).toBe("No unpublished changes since v1.3.0.");

    const open = { id: "snap-1", major: 1, minor: 0, patch: 0, sequence: 1 };
    const unsaved = analyzeVersionedPublish(input({ latestRelease: null, openSnapshot: open, hasChanges: false }));
    expect(unsaved.blockers).toEqual([{ kind: "NO_CHANGES", message: "No unsaved changes since v1.0.0_snapshot." }]);
    // nothing saved yet: there is nothing to compare with, never NO_CHANGES
    expect(analyzeVersionedPublish(input({ latestRelease: null, hasChanges: false, bump: null })).blockers).toEqual([]);
  });

  it("is raise-only (spec Q6)", () => {
    const major = input({ bump: { bump: "MAJOR", reasons: ["Trait removed"] } });
    expect(planVersionedPublish(major, "MINOR")).toMatchObject({ success: false, error: { code: "BUMP_TOO_LOW" } });
    expect(planVersionedPublish(major)).toMatchObject({ success: true, data: { label: "2.0.0_snapshot", sequence: 5, changeKind: "MAJOR", reasons: ["Trait removed"] } });
    const minor = input();
    expect(planVersionedPublish(minor, "MAJOR")).toMatchObject({ success: true, data: { label: "2.0.0_snapshot" } });
    expect(provisionalLabel(analyzeVersionedPublish(minor))).toBe("1.4.0_snapshot");
  });

  it("fails closed when a save after a release has no classification: INVALID_PLAN_INPUT, never a silent MINOR", () => {
    const unclassified = input({ bump: null });
    expect(planVersionedPublish(unclassified)).toMatchObject({ success: false, error: { code: "INVALID_PLAN_INPUT" } });
    expect(planVersionedPublish(unclassified, "MINOR")).toMatchObject({ success: false, error: { code: "INVALID_PLAN_INPUT" } });
    const blocked = planVersionedPublish({ ...unclassified, blockers: [{ kind: "NAME_CONFLICT", message: "taken" }] });
    expect(blocked).toMatchObject({ success: false, error: { code: "PUBLISH_BLOCKED" } });
  });

  it("provisionalLabel never defaults an unclassified bump to MINOR", () => {
    const analysis = analyzeVersionedPublish(input({ blockers: [{ kind: "NAME_CONFLICT", message: "taken" }], bump: null }));
    expect(analysis.suggestedBump).toBeNull();
    expect(provisionalLabel(analysis)).toBe("2.0.0_snapshot");
    expect(provisionalLabel(analyzeVersionedPublish(input({ latestRelease: null, bump: null })))).toBe("1.0.0_snapshot");
  });

  it("returns fresh objects: mutating a plan or analysis never leaks into later plans or the input", () => {
    const first = planVersionedPublish(input({ latestRelease: null, bump: null }));
    if (first.success) {
      first.data.version.major = 9;
      first.data.reasons.push("x");
    }
    expect(planVersionedPublish(input({ latestRelease: null, bump: null }))).toMatchObject({ success: true, data: { version: { major: 1, minor: 0 }, reasons: [] } });

    const unblocked = input({ bump: { bump: "MAJOR", reasons: ["Trait removed"] } });
    const plan = planVersionedPublish(unblocked);
    if (plan.success) plan.data.reasons.push("mutated");
    expect(unblocked.bump?.reasons).toEqual(["Trait removed"]);
    const blocked = input({ blockers: [{ kind: "NAME_CONFLICT", message: "taken" }], bump: { bump: "MAJOR", reasons: ["Trait removed"] } });
    const analysis = analyzeVersionedPublish(blocked);
    analysis.reasons.push("mutated");
    analysis.blockers[0].message = "mutated";
    expect(blocked.bump?.reasons).toEqual(["Trait removed"]);
    expect(blocked.blockers[0].message).toBe("taken");
  });

  it("is deterministic for identical input", () => {
    const same = input({ bump: { bump: "MINOR", reasons: ["Documentation changed"] } });
    expect(JSON.stringify(planVersionedPublish(same))).toBe(JSON.stringify(planVersionedPublish(same)));
    expect(JSON.stringify(analyzeVersionedPublish(same))).toBe(JSON.stringify(analyzeVersionedPublish(same)));
  });
});
