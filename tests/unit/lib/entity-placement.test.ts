import { describe, expect, it } from "vitest";
import {
  domainLabel,
  domainSegment,
  productSegment,
  TENANT_LEVEL_DOMAIN_SLUG,
  TENANT_LEVEL_PRODUCT_SLUG,
} from "@/lib/entity-placement";

describe("entity placement fallbacks", () => {
  it("uses the real domain and product when the entity is placed", () => {
    expect(domainLabel({ name: "Payments" })).toBe("Payments");
    expect(domainSegment({ slug: "payments" })).toBe("payments");
    expect(productSegment({ slug: "checkout" })).toBe("checkout");
  });

  it("falls back to the Enterprise label and tenant-level URL segments", () => {
    expect(domainLabel(null)).toBe("Enterprise");
    expect(domainLabel(undefined)).toBe("Enterprise");
    expect(domainSegment(null)).toBe(TENANT_LEVEL_DOMAIN_SLUG);
    expect(productSegment(null)).toBe(TENANT_LEVEL_PRODUCT_SLUG);
    expect(`/schemas/${domainSegment(null)}/${productSegment(null)}/customer`).toBe(
      "/schemas/enterprise/entities/customer"
    );
  });
});
