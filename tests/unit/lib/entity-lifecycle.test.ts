import { describe, it, expect } from "vitest";
import { canTransition, isReadOnly } from "@/lib/entity-lifecycle";

describe("canTransition", () => {
  it("allows DRAFT → ACTIVE", () => {
    expect(canTransition("DRAFT", "ACTIVE").allowed).toBe(true);
  });

  it("allows ACTIVE → DEPRECATED", () => {
    expect(canTransition("ACTIVE", "DEPRECATED").allowed).toBe(true);
  });

  it("allows DEPRECATED → RETIRED", () => {
    expect(canTransition("DEPRECATED", "RETIRED").allowed).toBe(true);
  });

  it("blocks DRAFT → DEPRECATED (must go through ACTIVE)", () => {
    const result = canTransition("DRAFT", "DEPRECATED");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Cannot transition");
  });

  it("blocks DRAFT → RETIRED", () => {
    expect(canTransition("DRAFT", "RETIRED").allowed).toBe(false);
  });

  it("blocks ACTIVE → DRAFT (no going back)", () => {
    expect(canTransition("ACTIVE", "DRAFT").allowed).toBe(false);
  });

  it("blocks RETIRED → anything", () => {
    expect(canTransition("RETIRED", "DRAFT").allowed).toBe(false);
    expect(canTransition("RETIRED", "ACTIVE").allowed).toBe(false);
    expect(canTransition("RETIRED", "DEPRECATED").allowed).toBe(false);
  });

  it("blocks same-status transition", () => {
    const result = canTransition("ACTIVE", "ACTIVE");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("already");
  });
});

describe("isReadOnly", () => {
  it("returns true for RETIRED", () => {
    expect(isReadOnly("RETIRED")).toBe(true);
  });

  it("returns false for other statuses", () => {
    expect(isReadOnly("DRAFT")).toBe(false);
    expect(isReadOnly("ACTIVE")).toBe(false);
    expect(isReadOnly("DEPRECATED")).toBe(false);
  });
});
