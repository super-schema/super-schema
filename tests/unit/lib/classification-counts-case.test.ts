/** Bug-hunt #7: the tally and the filter must agree on case (`pii` is the standard PII level for both). */
import { describe, it, expect } from "vitest";
import {
  classificationCountsFromGroups,
  matchesClassificationFilter,
  otherClassificationCounts,
  normalizeClassification,
} from "@/lib/classification-counts";

describe("classification case", () => {
  it("counts a lower-case standard level under the standard key", () => {
    const counts = classificationCountsFromGroups([
      { entityId: "e", classification: "pii", _count: 2 },
      { entityId: "e", classification: "PII", _count: 3 },
      { entityId: "e", classification: "Public", _count: 1 },
    ]).get("e")!;
    expect(counts.PII).toBe(5);
    expect(counts.PUBLIC).toBe(1);
    expect(otherClassificationCounts(counts)).toEqual([]);
  });

  it("keeps a vendor level under its own name", () => {
    const counts = classificationCountsFromGroups([{ entityId: "e", classification: "class4", _count: 2 }]).get("e")!;
    expect(otherClassificationCounts(counts)).toEqual([["class4", 2]]);
  });

  it("tally and filter agree for every spelling", () => {
    for (const level of ["pii", "PII", "Pii", "sensitive", "class4"]) {
      const counts = classificationCountsFromGroups([{ entityId: "e", classification: level, _count: 1 }]).get("e")!;
      const key = normalizeClassification(level);
      expect(counts[key]).toBe(1);
      expect(matchesClassificationFilter(level, key)).toBe(true);
    }
  });
});
