import { describe, it, expect } from "vitest";
import {
  analyzeVersionedPublish, eventSpecPublishInput, messagePublishInput, planVersionedPublish, provisionalLabel,
  type MessagePublishState,
} from "@/lib/events/publish-plan";
import type { EventSpecBumpSide } from "@/lib/events/bump-rules";

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
});

describe("messagePublishInput", () => {
  // Wave 0 validator text (src/lib/events/catalog-specs.ts): RFC 9110 media types, parameters allowed.
  const contentTypeProblem = 'contentType "avro binary" is not a valid media type (expected type/subtype with optional "; name=value" parameters)';
  const state = (over: Partial<MessagePublishState> = {}): MessagePublishState => ({
    name: "OrderCreated",
    hasUnpublishedChanges: true,
    spec: { traitIds: ["t1"] },
    pins: [
      { role: "payload", entityId: "e1", entityName: "Order", version: { id: "v21", label: "2.1", major: 2 }, latestLabel: "2.1" },
      { role: "key", entityId: "e2", entityName: "OrderKey", version: null, latestLabel: "1.0" },
      { role: "headers", entityId: "e3", entityName: "Headers", version: null, latestLabel: null },
    ],
    missingTraitIds: ["t9"],
    traitNames: {},
    specProblems: [contentTypeProblem],
    nameConflict: '"OrderCreated" is already used by Entity "OrderCreated" at Product level.',
    latest: null,
    ...over,
  });

  it("reports unpublished pins, missing traits, spec problems and name conflicts together; no resolved spec", () => {
    const { input, resolved } = messagePublishInput(state());
    expect(resolved).toBeNull();
    expect(input.blockers.map((b) => b.message)).toEqual([
      "Kafka key: pick a published version of OrderKey (latest is v1.0)",
      "Headers: publish Headers first, then pin its version",
      'Trait "t9" no longer exists or is not a MESSAGE trait',
      contentTypeProblem,
      '"OrderCreated" is already used by Entity "OrderCreated" at Product level.',
    ]);
  });

  it("builds the frozen MessageResolvedSpec and classifies against the latest version", () => {
    const prev = { name: "OrderCreated", spec: { traitIds: ["t1"] }, payload: { entityId: "e1", entityName: "Order", entityVersionId: "v13", label: "1.3", major: 1 }, headers: null, key: null };
    const { input, resolved } = messagePublishInput(
      state({
        pins: [{ role: "payload", entityId: "e1", entityName: "Order", version: { id: "v21", label: "2.1", major: 2 }, latestLabel: "2.1" }],
        missingTraitIds: [], specProblems: [], nameConflict: null,
        latest: { ...latest, resolved: prev },
      })
    );
    expect(resolved).toEqual({ name: "OrderCreated", spec: { traitIds: ["t1"] }, payload: { entityId: "e1", entityName: "Order", entityVersionId: "v21", label: "2.1", major: 2 }, headers: null, key: null });
    expect(input.bump).toEqual({ bump: "MAJOR", reasons: ["Payload pin moved from Order v1.3 to v2.1 (new major)"] });
  });
});

describe("eventSpecPublishInput", () => {
  const current: EventSpecBumpSide = { document: { info: { title: "x" }, servers: [], operations: [] }, channelAddresses: {}, channelNames: {}, messageVersions: {} };

  it("turns unresolved refs, draft messages and error diagnostics (capped at 20) into blockers; warnings never block", () => {
    const errors = Array.from({ length: 22 }, (_, i) => ({ severity: "error" as const, code: "E", message: `e${i}`, pointer: `/p/${i}` }));
    const input = eventSpecPublishInput({
      latest: null, hasChanges: true, previous: null, current,
      unresolved: [{ pointer: "/operations/0/channelId", message: 'Channel "c9" not found' }],
      unpublishedMessages: [{ id: "m1", name: "OrderCreated" }],
      diagnostics: [...errors, { severity: "warning", code: "W", message: "w", pointer: "" }],
      nameConflict: null,
    });
    expect(input.blockers.slice(0, 3)).toEqual([
      { kind: "UNRESOLVED_REFERENCE", message: 'Channel "c9" not found', pointer: "/operations/0/channelId" },
      { kind: "UNPUBLISHED_MESSAGE", message: "Message OrderCreated is an unpublished draft — publish it and pick its version" },
      { kind: "VALIDATION_ERROR", message: "E: e0", pointer: "/p/0" },
    ]);
    expect(input.blockers).toHaveLength(2 + 20 + 1);
    expect(input.blockers.at(-1)).toEqual({ kind: "VALIDATION_ERROR", message: "…and 2 more validation error(s)" });
    expect(input.bump).toBeNull();
  });
});
