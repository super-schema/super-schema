import { describe, it, expect } from "vitest";
import { isReservedSchemaRouteSlug, isReservedEntityRouteSlug, isReservedProductRouteSlug, reservedEntitySlugMessage } from "@/lib/slug";

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
  it("product route", () => {
    expect(isReservedProductRouteSlug("traits")).toBe(true);
    expect(isReservedProductRouteSlug("checkout")).toBe(false);
  });
  it("reserved entity slug message", () => {
    expect(reservedEntitySlugMessage("Events")).toContain("events");
    expect(reservedEntitySlugMessage("Events")).toContain("reserved");
    expect(reservedEntitySlugMessage("Order")).toBe(null);
  });
});
