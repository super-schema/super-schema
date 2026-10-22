import { describe, expect, it } from "vitest";
import {
  classificationCountsFromGroups,
  classificationFilterOptions,
  emptyClassificationCounts,
  matchesClassificationFilter,
  otherClassificationCounts,
  standardClassificationVariant,
} from "@/lib/classification-counts";

describe("classificationCountsFromGroups", () => {
  it("builds per-entity counts from mixed classification groups", () => {
    const counts = classificationCountsFromGroups([
      { entityId: "e1", classification: "PII", _count: 3 },
      { entityId: "e1", classification: "PUBLIC", _count: 2 },
      { entityId: "e1", classification: "NEVER_STORED", _count: 1 },
      { entityId: "e2", classification: "INTERNAL", _count: 4 },
      { entityId: "e2", classification: "SENSITIVE", _count: 1 },
    ]);
    expect(counts.get("e1")).toEqual({ NEVER_STORED: 1, PII: 3, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 2 });
    expect(counts.get("e2")).toEqual({ NEVER_STORED: 0, PII: 0, SENSITIVE: 1, INTERNAL: 4, PUBLIC: 0 });
  });

  it("counts unclassified (null) fields as SENSITIVE, the product default", () => {
    const counts = classificationCountsFromGroups([
      { entityId: "e1", classification: null, _count: 2 },
      { entityId: "e1", classification: "SENSITIVE", _count: 1 },
    ]);
    expect(counts.get("e1")?.SENSITIVE).toBe(3);
  });

  it("counts a level outside the scale under its own name (an imported vendor level such as class4)", () => {
    const counts = classificationCountsFromGroups([
      { entityId: "e1", classification: "class4", _count: 3 },
      { entityId: "e1", classification: "constructor", _count: 2 },
      { entityId: "e1", classification: "__proto__", _count: 9 },
      { entityId: "e1", classification: "PII", _count: 1 },
      { entityId: "e1", classification: null, _count: 1 },
    ]);
    const e1 = counts.get("e1")!;
    expect(e1).toMatchObject({ NEVER_STORED: 0, PII: 1, SENSITIVE: 1, INTERNAL: 0, PUBLIC: 0, class4: 3 });
    expect(Object.prototype.hasOwnProperty.call(e1, "constructor") && e1.constructor).toBe(2);
    expect(Object.getPrototypeOf(e1)).toBe(Object.prototype);
    expect(otherClassificationCounts(e1)).toEqual([["class4", 3], ["constructor", 2]]);
  });

  it("seeds zeroed counts for entities with no fields when their ids are given", () => {
    const counts = classificationCountsFromGroups(
      [{ entityId: "e1", classification: "PII", _count: 1 }],
      ["e1", "empty"]
    );
    expect(counts.get("empty")).toEqual(emptyClassificationCounts());
    expect(counts.get("empty")).toEqual({ NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 });
    expect(counts.get("e1")?.PII).toBe(1);
  });

  it("returns an empty map for no groups and no ids", () => {
    expect(classificationCountsFromGroups([]).size).toBe(0);
  });

  it("never shares a counts object between entities", () => {
    const counts = classificationCountsFromGroups([], ["a", "b"]);
    counts.get("a")!.PII = 9;
    expect(counts.get("b")?.PII).toBe(0);
    expect(emptyClassificationCounts().PII).toBe(0);
  });
});

describe("the field list classification filter", () => {
  it("lists the standard five, then the other levels actually present", () => {
    const options = classificationFilterOptions(["class4", "PII", null, "class4", "Class2", "pii"]);
    expect(options.map((o) => o.value)).toEqual(["NEVER_STORED", "PII", "SENSITIVE", "INTERNAL", "PUBLIC", "Class2", "class4"]);
    expect(options.find((o) => o.value === "NEVER_STORED")?.label).toBe("Never Stored");
    expect(classificationFilterOptions([]).map((o) => o.value)).toEqual(["NEVER_STORED", "PII", "SENSITIVE", "INTERNAL", "PUBLIC"]);
  });

  it("matches a standard level case-insensitively and any other level exactly", () => {
    expect(matchesClassificationFilter("pii", "PII")).toBe(true);
    expect(matchesClassificationFilter("class4", "class4")).toBe(true);
    expect(matchesClassificationFilter("class4", "CLASS4")).toBe(false);
    expect(matchesClassificationFilter(null, "PII")).toBe(false);
  });
});

describe("standardClassificationVariant", () => {
  it("maps the levels that have a badge variant and leaves every other level to the neutral style", () => {
    expect(standardClassificationVariant("PII")).toBe("pii");
    expect(standardClassificationVariant("Internal")).toBe("internal");
    expect(standardClassificationVariant("class4")).toBeUndefined();
    expect(standardClassificationVariant("NEVER_STORED")).toBeUndefined();
  });
});
