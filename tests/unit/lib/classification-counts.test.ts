import { describe, expect, it } from "vitest";
import {
  classificationCountsFromGroups,
  emptyClassificationCounts,
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

  it("ignores classifications that are not part of the scale", () => {
    const counts = classificationCountsFromGroups([
      { entityId: "e1", classification: "TOP_SECRET", _count: 5 },
      { entityId: "e1", classification: "constructor", _count: 5 },
      { entityId: "e1", classification: "PII", _count: 1 },
    ]);
    expect(counts.get("e1")).toEqual({ NEVER_STORED: 0, PII: 1, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 });
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
