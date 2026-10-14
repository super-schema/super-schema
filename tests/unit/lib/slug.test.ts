import { describe, it, expect } from "vitest";
import { isReservedSchemaRouteSlug, isReservedEntityRouteSlug } from "@/lib/slug";

describe("reserved slugs", () => {
  it("schema route", () => {
    expect(isReservedSchemaRouteSlug("enterprise")).toBe(true);
    expect(isReservedSchemaRouteSlug("type-mappings")).toBe(true);
    expect(isReservedSchemaRouteSlug("payments")).toBe(false);
  });
  it("entity route", () => {
    for (const s of ["new", "events", "channels", "messages", "specs", "traits", "data-types", "apis"]) {
      expect(isReservedEntityRouteSlug(s)).toBe(true);
    }
    expect(isReservedEntityRouteSlug("order")).toBe(false);
  });
});
