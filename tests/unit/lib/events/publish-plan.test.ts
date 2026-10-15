import { describe, it, expect } from "vitest";
import {
  analyzeVersionedPublish, eventSpecPublishInput, messagePublishInput, planVersionedPublish, provisionalLabel,
  type MessagePublishState,
} from "@/lib/events/publish-plan";
import type { EventSpecBumpSide } from "@/lib/events/bump-rules";
import { validateMessageSpec } from "@/lib/events/catalog-specs";

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

describe("messagePublishInput", () => {
  // The real Wave 0 validator text (RFC 9110 media types), not a hard-coded copy.
  const [contentTypeProblem] = validateMessageSpec({ contentType: "avro binary", traitIds: [] });
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

  it("blocks a message with no payload pin at all (Payload is required) and builds no resolved spec", () => {
    const { input, resolved } = messagePublishInput(state({ pins: [], missingTraitIds: [], specProblems: [], nameConflict: null }));
    expect(resolved).toBeNull();
    expect(input.blockers).toEqual([{ kind: "MISSING_ENTITY", message: "Payload is required" }]);
    expect(planVersionedPublish(input)).toMatchObject({ success: false, error: { code: "PUBLISH_BLOCKED" } });
    // Also blocked when only headers / key roles are present.
    const roles = messagePublishInput(
      state({ pins: [{ role: "key", entityId: "e2", entityName: "OrderKey", version: { id: "k1", label: "1.0", major: 1 }, latestLabel: "1.0" }], missingTraitIds: [], specProblems: [], nameConflict: null })
    );
    expect(roles.resolved).toBeNull();
    expect(roles.input.blockers.map((b) => b.message)).toEqual(["Payload is required"]);
  });

  it("freezes a copy of the spec: mutating the resolved spec never changes the state, and passes hasChanges through", () => {
    const s = state({
      pins: [{ role: "payload", entityId: "e1", entityName: "Order", version: { id: "v21", label: "2.1", major: 2 }, latestLabel: "2.1" }],
      missingTraitIds: [], specProblems: [], nameConflict: null, hasUnpublishedChanges: false,
    });
    const { input, resolved } = messagePublishInput(s);
    expect(input.hasChanges).toBe(false);
    resolved?.spec.traitIds.push("mutated");
    expect(s.spec.traitIds).toEqual(["t1"]);
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

  it("blocks every trait whose headers entity is unpinned (UNPUBLISHED_PIN, named by the trait), together with the other blockers", () => {
    const input = eventSpecPublishInput({
      latest: null, hasChanges: true, previous: null, current,
      unresolved: [{ pointer: "/operations/0/channelId", message: 'Channel "c9" not found' }],
      unpublishedMessages: [{ id: "m1", name: "OrderCreated" }],
      unpinnedTraitHeaders: [{ id: "t1", name: "CloudEvents" }, { id: "t2", name: "Tracing" }],
      diagnostics: [{ severity: "error", code: "E", message: "bad", pointer: "/p" }],
      nameConflict: "taken",
    });
    expect(input.blockers.map((b) => b.kind)).toEqual(["UNRESOLVED_REFERENCE", "UNPUBLISHED_MESSAGE", "UNPUBLISHED_PIN", "UNPUBLISHED_PIN", "VALIDATION_ERROR", "NAME_CONFLICT"]);
    const pins = input.blockers.filter((b) => b.kind === "UNPUBLISHED_PIN").map((b) => b.message);
    expect(pins[0]).toBe("Trait CloudEvents: its headers entity is not pinned to a published version — pin a published entity version on the trait, then publish again");
    expect(pins[1]).toContain("Trait Tracing:");
    expect(planVersionedPublish(input)).toMatchObject({ success: false, error: { code: "PUBLISH_BLOCKED" } });
  });

  it("pinned traits (empty or omitted unpinnedTraitHeaders) add no blocker, and warnings / info diagnostics never block", () => {
    const base = {
      latest: null, hasChanges: true, previous: null, current, unresolved: [], unpublishedMessages: [],
      diagnostics: [
        { severity: "warning" as const, code: "PAYLOAD_NOT_VALIDATED", message: "w", pointer: "/x" },
        { severity: "info" as const, code: "UNPUBLISHED_MESSAGE", message: "i", pointer: "" },
      ],
      nameConflict: null,
    };
    expect(eventSpecPublishInput(base).blockers).toEqual([]);
    expect(eventSpecPublishInput({ ...base, unpinnedTraitHeaders: [] }).blockers).toEqual([]);
    expect(planVersionedPublish(eventSpecPublishInput({ ...base, unpinnedTraitHeaders: [] }))).toMatchObject({ success: true, data: { label: "1.0" } });
  });
});

describe("eventSpecPublishInput: classification and fail-closed inputs (fix round 1)", () => {
  const versions = {
    "mv-1.3": { messageId: "m1", messageName: "OrderCreated", major: 1, label: "1.3" },
    "mv-1.4": { messageId: "m1", messageName: "OrderCreated", major: 1, label: "1.4" },
    "mv-c": { messageId: "m2", messageName: "OrderCancelled", major: 1, label: "1.0" },
  };
  const side = (ids: string[], over: Partial<EventSpecBumpSide> = {}): EventSpecBumpSide => ({
    document: { info: { title: "x" }, servers: [], operations: [{ key: "o", action: "send", channelId: "ch", messageVersionIds: ids, traitIds: [] }] },
    channelAddresses: { ch: "a.b" },
    channelNames: { ch: "orders" },
    messageVersions: Object.fromEntries(Object.entries(versions).filter(([id]) => ids.includes(id))),
    ...over,
  });
  const facts = (over: Partial<Parameters<typeof eventSpecPublishInput>[0]> = {}): Parameters<typeof eventSpecPublishInput>[0] => ({
    latest,
    hasChanges: true,
    previous: side(["mv-1.3", "mv-c"]),
    current: side(["mv-1.3", "mv-c"]),
    unresolved: [],
    unpublishedMessages: [],
    diagnostics: [],
    nameConflict: null,
    ...over,
  });

  it("classifies against the previous side and passes latest / hasChanges through (as copies)", () => {
    const input = eventSpecPublishInput(facts({ current: side(["mv-1.4", "mv-c"]), hasChanges: false }));
    expect(input).toEqual({
      latest,
      hasChanges: false,
      blockers: [],
      bump: { bump: "MINOR", reasons: ['Message OrderCreated moved from v1.3 to v1.4 in "o"'] },
    });
    const source = facts();
    expect(eventSpecPublishInput(source).latest).not.toBe(source.latest);
    expect(analyzeVersionedPublish(eventSpecPublishInput(facts({ hasChanges: false }))).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES"]);
  });

  it("reports a name conflict next to unresolved references, all together", () => {
    const input = eventSpecPublishInput(facts({ nameConflict: "checkout-service is taken", unresolved: [{ pointer: "/operations/0/channelId", message: "Channel not found" }] }));
    expect(input.blockers.map((b) => b.kind)).toEqual(["UNRESOLVED_REFERENCE", "NAME_CONFLICT"]);
  });

  it("a latest version without a previous side cannot be classified, so planning errors instead of defaulting to MINOR", () => {
    const input = eventSpecPublishInput(facts({ previous: null }));
    expect(input.bump).toBeNull();
    expect(planVersionedPublish(input)).toMatchObject({ success: false, error: { code: "INVALID_PLAN_INPUT" } });
  });

  it("a previous-side unknown message version blocks publish and fails the bump closed to MAJOR", () => {
    const previous = side(["mv-1.3", "gone"], { messageVersions: { "mv-1.3": versions["mv-1.3"] } });
    const input = eventSpecPublishInput(facts({ previous, current: side(["mv-1.3"]) }));
    expect(input.blockers).toEqual([
      { kind: "UNRESOLVED_REFERENCE", message: 'The latest published version references message version "gone" in "o", which cannot be resolved' },
    ]);
    expect(input.bump?.bump).toBe("MAJOR");
    expect(planVersionedPublish(input)).toMatchObject({ success: false, error: { code: "PUBLISH_BLOCKED" } });
  });

  it("unknown reply ids are covered too (previous and current side)", () => {
    const previous = side(["mv-1.3"]);
    previous.document.operations[0].reply = { channelId: "ch", messageVersionIds: ["gone-reply"] };
    const current = side(["mv-1.3"]);
    current.document.operations[0].reply = { channelId: "ch", messageVersionIds: ["gone-reply"] };
    const input = eventSpecPublishInput(facts({ previous, current }));
    expect(input.blockers.map((b) => b.message)).toEqual([
      'The latest published version references message version "gone-reply" in "o reply", which cannot be resolved',
      'Message version "gone-reply" in "o reply" not found',
    ]);
    expect(input.bump?.bump).toBe("MAJOR");
  });

  it("a current-side unknown id that is not a draft blocks, once, with its pointer", () => {
    const input = eventSpecPublishInput(facts({ current: side(["mv-1.3", "dangling"]) }));
    expect(input.blockers).toEqual([{ kind: "UNRESOLVED_REFERENCE", message: 'Message version "dangling" in "o" not found', pointer: "/operations/0/messageVersionIds/1" }]);
    // The resolver already reported that pointer: no duplicate blocker.
    const reported = eventSpecPublishInput(
      facts({ current: side(["mv-1.3", "dangling"]), unresolved: [{ pointer: "/operations/0/messageVersionIds/1", message: 'Message version "dangling" not found' }] })
    );
    expect(reported.blockers).toEqual([{ kind: "UNRESOLVED_REFERENCE", message: 'Message version "dangling" not found', pointer: "/operations/0/messageVersionIds/1" }]);
  });

  it("a first publish also blocks on a current-side unknown id", () => {
    const input = eventSpecPublishInput(facts({ latest: null, previous: null, current: side(["dangling"]) }));
    expect(input.blockers.map((b) => b.kind)).toEqual(["UNRESOLVED_REFERENCE"]);
    expect(input.bump).toBeNull();
  });

  it("a draft message is not a removal: the UNPUBLISHED_MESSAGE blocker stands and the bump stays pending, not a false MAJOR", () => {
    const input = eventSpecPublishInput(facts({ current: side(["m1", "mv-c"]), unpublishedMessages: [{ id: "m1", name: "OrderCreated" }] }));
    expect(input.blockers).toEqual([
      { kind: "UNPUBLISHED_MESSAGE", message: "Message OrderCreated is an unpublished draft — publish it and pick its version" },
    ]);
    expect(input.bump).toBeNull();
    expect(analyzeVersionedPublish(input)).toMatchObject({ suggestedBump: null, reasons: [] });
    expect(planVersionedPublish(input)).toMatchObject({ success: false, error: { code: "PUBLISH_BLOCKED" } });
  });

  it("with a draft present a definite MAJOR (removed operation) is still reported", () => {
    const current = side(["m1"]);
    current.document.operations = [];
    const input = eventSpecPublishInput(facts({ current, unpublishedMessages: [{ id: "m1", name: "OrderCreated" }] }));
    expect(input.bump).toEqual({ bump: "MAJOR", reasons: ['Operation "o" removed'] });
  });
});

