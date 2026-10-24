import { describe, it, expect } from "vitest";
import { analyzePublish, planPublish, type PublishState } from "@/lib/entity-versioning/publish-plan";
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
  return { entity: ENTITY, latest: null, currentFields: [ID], references: [], ...overrides };
}

const published = (fields: FieldSnapshot[]) => ({ id: "v-5", major: 2, minor: 1, sequence: 5, fieldSnapshot: fields });

describe("first publish", () => {
  it("is 1.0 INITIAL with sequence mirroring Entity.version", () => {
    expect(planPublish(state())).toEqual({
      success: true,
      data: { version: { major: 1, minor: 0 }, label: "1.0", sequence: 1, changeKind: "INITIAL", pins: [], referencedVersions: [] },
    });
    const legacy = planPublish(state({ entity: { ...ENTITY, version: 4 } }));
    expect(legacy.success && legacy.data.sequence).toBe(4);
  });

  it("ignores a requested bump", () => {
    const res = planPublish(state(), "MAJOR");
    expect(res.success && res.data.label).toBe("1.0");
  });

  it("offers only the initial label", () => {
    expect(analyzePublish(state())).toMatchObject({
      isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0", blockers: [],
    });
  });
});

describe("later publishes", () => {
  it("suggests MINOR for an additive change and allows raising to MAJOR", () => {
    const s = state({ latest: published([ID]), currentFields: [ID, EMAIL] });
    expect(analyzePublish(s)).toMatchObject({
      isFirstPublish: false, suggestedBump: "MINOR", latestLabel: "2.1", candidateLabels: { MINOR: "2.2", MAJOR: "3.0" },
    });
    expect(planPublish(s)).toMatchObject({ success: true, data: { label: "2.2", changeKind: "MINOR", sequence: 6 } });
    expect(planPublish(s, "MAJOR")).toMatchObject({ success: true, data: { label: "3.0", changeKind: "MAJOR", sequence: 6 } });
  });

  it("suggests MAJOR for a breaking change and refuses MINOR", () => {
    const s = state({ latest: published([ID, EMAIL]), currentFields: [ID] });
    expect(analyzePublish(s).suggestedBump).toBe("MAJOR");
    const low = planPublish(s, "MINOR");
    expect(!low.success && low.error.code).toBe("BUMP_TOO_LOW");
    expect(planPublish(s)).toMatchObject({ success: true, data: { label: "3.0", changeKind: "MAJOR" } });
  });
});

describe("blockers and pins", () => {
  it("blocks when nothing changed since the latest version", () => {
    const s = state({ latest: published([ID]), entity: { ...ENTITY, hasUnpublishedChanges: false } });
    expect(analyzePublish(s).blockers).toEqual([{ kind: "NO_CHANGES", message: "No unpublished changes since v2.1." }]);
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

  it("the plan carries the referenced versions the closure used, unchanged", () => {
    const referencedVersions = [
      { ref: { entityId: "b", domain: "d", product: "p", entity: "B" }, version: "1.2", pinned: false },
      { ref: { entityId: "c", domain: "d", product: "p", entity: "C" }, version: "1.0", pinned: true },
    ];
    expect(planPublish(state({ referencedVersions }))).toMatchObject({ success: true, data: { referencedVersions } });
    expect(planPublish(state({ latest: published([ID]), currentFields: [ID, EMAIL], referencedVersions }))).toMatchObject({
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
