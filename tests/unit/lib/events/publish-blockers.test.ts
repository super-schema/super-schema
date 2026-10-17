import { describe, it, expect } from "vitest";
import type { EventPublishAnalysis, EventPublishBlocker } from "@/lib/events/publish-plan";
import { foldPublishBlockers } from "@/lib/events/publish-blockers";

function analysis(blockers: EventPublishBlocker[]): EventPublishAnalysis {
  return {
    isFirstPublish: false, latestLabel: "1.0", suggestedBump: "MINOR", candidateLabels: { MAJOR: "2.0", MINOR: "1.1" },
    initialLabel: "1.0", reasons: ["Message added"], blockers,
  };
}

describe("foldPublishBlockers", () => {
  it("folds blockers with the identical message into one (one root cause reported at up to three pointers)", () => {
    const missing = '"ver-9" is not a published version of Order';
    const folded = foldPublishBlockers(analysis([
      { kind: "MISSING_ENTITY", message: missing, pointer: "/messages/0/payload" },
      { kind: "UNRESOLVED_REFERENCE", message: missing, pointer: "/components/messages/order-created/payload" },
      { kind: "VALIDATION_ERROR", message: missing, pointer: "/channels/orders/messages/order-created/payload" },
    ]));
    expect(folded.blockers).toHaveLength(1);
    expect(folded.blockers[0].message).toBe(missing);
  });

  it("keeps different messages apart, in the order they first appeared", () => {
    const folded = foldPublishBlockers(analysis([
      { kind: "UNPUBLISHED_PIN", message: "Order has no published version pinned", pointer: "/messages/0/payload" },
      { kind: "UNPUBLISHED_PIN", message: "Shipment has no published version pinned", pointer: "/messages/1/payload" },
      { kind: "UNPUBLISHED_PIN", message: "Order has no published version pinned", pointer: "/messages/2/headers" },
    ]));
    expect(folded.blockers.map((b) => b.message)).toEqual(["Order has no published version pinned", "Shipment has no published version pinned"]);
  });

  it("drops the pointer: it may name the draft or the emitted document, so it is never presented as a path", () => {
    const folded = foldPublishBlockers(analysis([{ kind: "VALIDATION_ERROR", message: "bad", pointer: "/channels/x" }]));
    expect(folded.blockers).toEqual([{ kind: "VALIDATION_ERROR", message: "bad" }]);
    expect("pointer" in folded.blockers[0]).toBe(false);
  });

  it("keeps the kind of the first blocker of a fold", () => {
    const folded = foldPublishBlockers(analysis([
      { kind: "MISSING_ENTITY", message: "same", pointer: "/a" },
      { kind: "VALIDATION_ERROR", message: "same", pointer: "/b" },
    ]));
    expect(folded.blockers).toEqual([{ kind: "MISSING_ENTITY", message: "same" }]);
  });

  it("treats a message that differs only in text as a different blocker (exact match, no guessing)", () => {
    const folded = foldPublishBlockers(analysis([
      { kind: "VALIDATION_ERROR", message: "Channel is empty", pointer: "/a" },
      { kind: "VALIDATION_ERROR", message: "Channel is empty.", pointer: "/b" },
    ]));
    expect(folded.blockers).toHaveLength(2);
  });

  it("leaves everything else of the analysis untouched and does not mutate the input", () => {
    const input = analysis([{ kind: "NO_CHANGES", message: "No unpublished changes since v1.0." }]);
    const before = JSON.stringify(input);
    const folded = foldPublishBlockers(input);
    expect(folded).toEqual({ ...input, blockers: [{ kind: "NO_CHANGES", message: "No unpublished changes since v1.0." }] });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("is a no-op for an analysis without blockers", () => {
    const input = analysis([]);
    expect(foldPublishBlockers(input).blockers).toEqual([]);
  });
});
