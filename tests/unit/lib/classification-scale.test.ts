import { describe, expect, it } from "vitest";
import { CLASS_SCALE, DEFAULT_CLASS, classLabel, classNumberOf, systemLevelForClass } from "@/lib/classification-scale";

describe("classification-scale", () => {
  it("maps the standard levels to classes 1-5", () => {
    expect(["NEVER_STORED", "PII", "SENSITIVE", "INTERNAL", "PUBLIC"].map((l) => classNumberOf(l))).toEqual([1, 2, 3, 4, 5]);
    expect(CLASS_SCALE).toHaveLength(5);
    expect(DEFAULT_CLASS).toBe(3);
  });
  it("is case-insensitive and defaults unclassified to 3", () => {
    expect(classNumberOf("pii")).toBe(2);
    expect(classNumberOf(null)).toBe(3);
    expect(classNumberOf(undefined)).toBe(3);
  });
  it("resolves custom levels through the map, else 3", () => {
    expect(classNumberOf("FINANCIAL", new Map([["FINANCIAL", 2]]))).toBe(2);
    expect(classNumberOf("FINANCIAL")).toBe(3);
  });
  it("accepts vendor classN levels in range only", () => {
    expect(classNumberOf("class4")).toBe(4);
    expect(classNumberOf("class9")).toBe(3);
  });
  it("round-trips class numbers and labels", () => {
    expect(systemLevelForClass(1)).toBe("NEVER_STORED");
    expect(classLabel("SENSITIVE")).toBe("Class 3 — Sensitive");
  });
});
