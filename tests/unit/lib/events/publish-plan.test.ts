import { describe, it, expect } from "vitest";
import { analyzeVersionedPublish, planVersionedPublish, provisionalLabel } from "@/lib/events/publish-plan";

// The generic planner the event publish is built on (document/bump.ts feeds it the classification).

const latest = { major: 1, minor: 3, sequence: 4 };

describe("versioned publish planner", () => {
  it("first publish is 1.0 INITIAL at sequence 1", () => {
    const input = { latest: null, hasChanges: true, blockers: [], bump: null };
    expect(analyzeVersionedPublish(input)).toMatchObject({ isFirstPublish: true, initialLabel: "1.0", candidateLabels: null });
    expect(planVersionedPublish(input)).toEqual({ success: true, data: { version: { major: 1, minor: 0 }, label: "1.0", sequence: 1, changeKind: "INITIAL", reasons: [] } });
  });

  it("blocks with NO_CHANGES (first) plus every other blocker, all together", () => {
    const r = planVersionedPublish({ latest, hasChanges: false, blockers: [{ kind: "NAME_CONFLICT", message: "taken" }], bump: { bump: "MINOR", reasons: [] } });
    expect(!r.success && r.error.code).toBe("PUBLISH_BLOCKED");
    expect(!r.success && (r.error.details as { blockers: Array<{ kind: string }> }).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES", "NAME_CONFLICT"]);
  });

  it("is raise-only (spec Q6)", () => {
    const major = { latest, hasChanges: true, blockers: [], bump: { bump: "MAJOR" as const, reasons: ["Trait removed"] } };
    expect(planVersionedPublish(major, "MINOR")).toMatchObject({ success: false, error: { code: "BUMP_TOO_LOW" } });
    expect(planVersionedPublish(major)).toMatchObject({ success: true, data: { label: "2.0", sequence: 5, changeKind: "MAJOR", reasons: ["Trait removed"] } });
    const minor = { ...major, bump: { bump: "MINOR" as const, reasons: [] } };
    expect(planVersionedPublish(minor)).toMatchObject({ success: true, data: { label: "1.4", changeKind: "MINOR" } });
    expect(planVersionedPublish(minor, "MAJOR")).toMatchObject({ success: true, data: { label: "2.0" } });
    expect(provisionalLabel(analyzeVersionedPublish(minor))).toBe("1.4");
  });

  it("fails closed when a republish has no classification: INVALID_PLAN_INPUT, never a silent MINOR", () => {
    const unclassified = { latest, hasChanges: true, blockers: [], bump: null };
    expect(planVersionedPublish(unclassified)).toMatchObject({ success: false, error: { code: "INVALID_PLAN_INPUT" } });
    expect(planVersionedPublish(unclassified, "MINOR")).toMatchObject({ success: false, error: { code: "INVALID_PLAN_INPUT" } });
    // With blockers the blockers win (they are the actionable information).
    const blocked = planVersionedPublish({ ...unclassified, blockers: [{ kind: "NAME_CONFLICT", message: "taken" }] });
    expect(blocked).toMatchObject({ success: false, error: { code: "PUBLISH_BLOCKED" } });
  });

  it("provisionalLabel never defaults an unclassified bump to MINOR", () => {
    const analysis = analyzeVersionedPublish({ latest, hasChanges: true, blockers: [{ kind: "NAME_CONFLICT", message: "taken" }], bump: null });
    expect(analysis.suggestedBump).toBeNull();
    expect(provisionalLabel(analysis)).toBe("2.0");
    expect(provisionalLabel(analyzeVersionedPublish({ latest: null, hasChanges: true, blockers: [], bump: null }))).toBe("1.0");
  });

  it("returns fresh objects: mutating a plan or analysis never leaks into later plans or the input", () => {
    const input = { latest, hasChanges: true, blockers: [{ kind: "NAME_CONFLICT" as const, message: "taken" }], bump: { bump: "MAJOR" as const, reasons: ["Trait removed"] } };
    const first = planVersionedPublish({ latest: null, hasChanges: true, blockers: [], bump: null });
    if (first.success) {
      first.data.version.major = 9;
      first.data.reasons.push("x");
    }
    expect(planVersionedPublish({ latest: null, hasChanges: true, blockers: [], bump: null })).toMatchObject({ success: true, data: { version: { major: 1, minor: 0 }, reasons: [] } });

    const unblocked = { ...input, blockers: [] };
    const plan = planVersionedPublish(unblocked);
    if (plan.success) plan.data.reasons.push("mutated");
    expect(unblocked.bump.reasons).toEqual(["Trait removed"]);
    const analysis = analyzeVersionedPublish(input);
    analysis.reasons.push("mutated");
    analysis.blockers[0].message = "mutated";
    expect(input.bump.reasons).toEqual(["Trait removed"]);
    expect(input.blockers[0].message).toBe("taken");
  });

  it("is deterministic for identical input", () => {
    const input = { latest, hasChanges: true, blockers: [], bump: { bump: "MINOR" as const, reasons: ["Documentation changed"] } };
    expect(JSON.stringify(planVersionedPublish(input))).toBe(JSON.stringify(planVersionedPublish(input)));
    expect(JSON.stringify(analyzeVersionedPublish(input))).toBe(JSON.stringify(analyzeVersionedPublish(input)));
  });
});
