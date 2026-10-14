import { describe, expect, it } from "vitest";
import { domainLabel } from "@/lib/entity-placement";

describe("entity placement fallbacks", () => {
  it("uses the real domain name when the entity is placed", () => {
    expect(domainLabel({ name: "Payments" })).toBe("Payments");
  });

  it("falls back to the Enterprise label when the entity is tenant-level", () => {
    expect(domainLabel(null)).toBe("Enterprise");
    expect(domainLabel(undefined)).toBe("Enterprise");
  });
});
