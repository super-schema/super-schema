import { describe, it, expect } from "vitest";
import { newEntityHrefForPath } from "@/lib/navigation/new-entity-target";

describe("newEntityHrefForPath", () => {
  it("targets the product named by the first two segments", () => {
    expect(newEntityHrefForPath("/schemas/payments/checkout")).toBe("/schemas/payments/checkout/new");
    expect(newEntityHrefForPath("/schemas/payments/checkout/abc123")).toBe("/schemas/payments/checkout/new");
  });

  it("targets the Enterprise level for anything under /schemas/enterprise", () => {
    expect(newEntityHrefForPath("/schemas/enterprise")).toBe("/schemas/enterprise/new");
    expect(newEntityHrefForPath("/schemas/enterprise/traits/t1")).toBe("/schemas/enterprise/new");
  });

  it("names no placement on the domain list or a bare domain page", () => {
    expect(newEntityHrefForPath("/schemas")).toBeNull();
    expect(newEntityHrefForPath("/schemas/payments")).toBeNull();
  });

  it("names no placement on a domain-level trait page (traits is a reserved segment, not a product)", () => {
    expect(newEntityHrefForPath("/schemas/payments/traits/t1")).toBeNull();
  });
});
