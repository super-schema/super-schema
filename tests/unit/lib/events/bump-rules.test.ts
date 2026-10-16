import { describe, it, expect } from "vitest";
import { comparePin, compareTraitHeaders, decide, stableStringify, type BumpTraitHeadersPin } from "@/lib/events/bump-rules";
import type { ResolvedPin } from "@/lib/events/types";

// The helpers the event document's bump classifier (document/bump.ts) is built from. The classifier itself is covered by
// tests/unit/lib/events/document/bump*.test.ts.

const pin = (entityName: string, label: string, entityId = `e-${entityName}`): ResolvedPin => ({
  entityId, entityName, entityVersionId: `${entityName}@${label}`, label, major: Number(label.split(".")[0]),
});

/** Run one comparison and return the classification it produced. */
function compare(prev: ResolvedPin | null, next: ResolvedPin | null) {
  const major: string[] = [];
  const minor: string[] = [];
  comparePin("Payload", prev, next, major, minor);
  return { major, minor, decision: decide(major, minor) };
}

describe("stableStringify", () => {
  it("ignores key order and undefined values", () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [2] } })).toBe(stableStringify({ a: { c: [2] }, b: 1 }));
  });

  it("keeps array order and tells different values apart", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify(undefined)).toBe("null");
  });
});

describe("decide", () => {
  it("is MAJOR when any breaking reason exists (listing the minor ones too) and MINOR otherwise", () => {
    expect(decide(["a"], ["b"])).toEqual({ bump: "MAJOR", reasons: ["a", "b"] });
    expect(decide([], ["b"])).toEqual({ bump: "MINOR", reasons: ["b"] });
    expect(decide([], [])).toEqual({ bump: "MINOR", reasons: [] });
  });
});

describe("comparePin (spec §6.1, D6)", () => {
  it("a minor entity bump is MINOR; an unchanged pin says nothing", () => {
    expect(compare(pin("Order", "2.1"), pin("Order", "2.2"))).toMatchObject({ minor: ["Payload pin moved from v2.1 to v2.2"], major: [] });
    expect(compare(pin("Order", "2.1"), pin("Order", "2.1"))).toMatchObject({ minor: [], major: [] });
    expect(compare(null, null)).toMatchObject({ minor: [], major: [] });
  });

  it("a pin moving to another major (up or down) or to another entity is MAJOR", () => {
    expect(compare(pin("Order", "2.1"), pin("Order", "3.0")).major).toEqual(["Payload pin moved from Order v2.1 to v3.0 (new major)"]);
    expect(compare(pin("Order", "3.0"), pin("Order", "2.1")).decision.bump).toBe("MAJOR");
    expect(compare(pin("Order", "2.1"), pin("Invoice", "1.0")).major).toEqual(["Payload now references Invoice instead of Order"]);
  });

  it("removing a pin is MAJOR, adding one is MINOR", () => {
    expect(compare(pin("OrderKey", "1.0"), null)).toMatchObject({ major: ["Payload removed (was OrderKey v1.0)"] });
    expect(compare(null, pin("CloudEventsHeaders", "1.0"))).toMatchObject({ minor: ["Payload added: CloudEventsHeaders v1.0"], major: [] });
  });
});

describe("compareTraitHeaders (R78): a trait's headers pin is part of every message that carries the trait", () => {
  const pinOf = (label: string, over: Partial<BumpTraitHeadersPin> = {}): BumpTraitHeadersPin => ({
    entityId: "e-ce", entityName: "CloudEventsHeaders", entityVersionId: `ce@${label}`, major: Number(label.split(".")[0]), label, ...over,
  });
  function run(prev: BumpTraitHeadersPin | null, next: BumpTraitHeadersPin | null) {
    const major: string[] = [];
    const minor: string[] = [];
    compareTraitHeaders("CloudEvents", prev, next, major, minor);
    return decide(major, minor);
  }

  it("a pin moving to a different major is MAJOR (up or down) and names the trait and the versions", () => {
    expect(run(pinOf("1.0"), pinOf("2.0"))).toEqual({
      bump: "MAJOR",
      reasons: ["Trait CloudEvents: headers pin moved from CloudEventsHeaders v1.0 to v2.0 (new major)"],
    });
    expect(run(pinOf("2.0"), pinOf("1.0")).bump).toBe("MAJOR");
  });

  it("a pin moving within the same major is only MINOR (with a reason)", () => {
    expect(run(pinOf("1.0"), pinOf("1.2"))).toEqual({ bump: "MINOR", reasons: ["Trait CloudEvents: headers pin moved from v1.0 to v1.2"] });
  });

  it("a headers entity added to or removed from a trait is MAJOR", () => {
    expect(run(null, pinOf("1.0"))).toEqual({ bump: "MAJOR", reasons: ["Trait CloudEvents: headers entity added (CloudEventsHeaders v1.0)"] });
    expect(run(pinOf("1.0"), null)).toEqual({ bump: "MAJOR", reasons: ["Trait CloudEvents: headers entity removed (was CloudEventsHeaders v1.0)"] });
  });

  it("pinning a different entity is MAJOR even at the same major", () => {
    const other = pinOf("1.0", { entityId: "e-other", entityName: "OtherHeaders", entityVersionId: "o@1.0" });
    expect(run(pinOf("1.0"), other).reasons).toEqual(["Trait CloudEvents: headers now reference OtherHeaders instead of CloudEventsHeaders"]);
  });

  it("an unchanged pin says nothing; an unknown major (version row gone / unpinned) is never a MAJOR on its own", () => {
    expect(run(pinOf("1.0"), pinOf("1.0"))).toEqual({ bump: "MINOR", reasons: [] });
    expect(run(null, null)).toEqual({ bump: "MINOR", reasons: [] });
    expect(run(pinOf("1.0"), pinOf("2.0", { major: null, label: null }))).toEqual({
      bump: "MINOR",
      reasons: ["Trait CloudEvents: headers pin moved from v1.0 to (unpinned)"],
    });
  });

  it("falls back to the entity id when no name is known", () => {
    expect(run(null, pinOf("1.0", { entityName: undefined })).reasons).toEqual(["Trait CloudEvents: headers entity added (e-ce v1.0)"]);
  });
});
