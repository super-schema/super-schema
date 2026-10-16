import { describe, it, expect } from "vitest";
import { levelOf, validateScope, ALLOWED_LEVELS } from "@/lib/levels";

describe("levelOf", () => {
  it("derives levels", () => {
    expect(levelOf({ domainId: null, productId: null })).toBe("TENANT");
    expect(levelOf({ domainId: "d", productId: null })).toBe("DOMAIN");
    expect(levelOf({ domainId: "d", productId: "p" })).toBe("PRODUCT");
  });
});

describe("validateScope", () => {
  const t = "t1";
  it("rejects productId without domainId", () => {
    const r = validateScope("dataType", { tenantId: t, domainId: null, productId: "p" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.code).toBe("INVALID_SCOPE");
  });
  it("enforces the placement matrix", () => {
    expect(validateScope("entity", { tenantId: t, domainId: "d", productId: null }).success).toBe(false);
    expect(validateScope("entity", { tenantId: t, domainId: null, productId: null }).success).toBe(true);
    expect(validateScope("api", { tenantId: t, domainId: null, productId: null }).success).toBe(false);
    expect(validateScope("api", { tenantId: t, domainId: "d", productId: null }).success).toBe(true);
    expect(validateScope("eventSpec", { tenantId: t, domainId: "d", productId: null }).success).toBe(false);
    expect(validateScope("eventSpec", { tenantId: t, domainId: "d", productId: "p" }).success).toBe(true);
    expect(validateScope("trait", { tenantId: t, domainId: null, productId: null }).success).toBe(true);
    expect(validateScope("trait", { tenantId: t, domainId: "d", productId: null }).success).toBe(true);
  });
  it("refuses a product-level trait with INVALID_SCOPE (the table CHECK is the second line of defence)", () => {
    const r = validateScope("trait", { tenantId: t, domainId: "d", productId: "p" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.code).toBe("INVALID_SCOPE");
    expect(!r.success && r.error.suggestedFix).toBe("Allowed levels: Enterprise, Domain.");
  });
  it("matrix matches spec §4.1 as amended (no message / channel assets, traits never at product level)", () => {
    expect(ALLOWED_LEVELS).toEqual({
      dataType: ["TENANT", "DOMAIN", "PRODUCT"],
      entity: ["TENANT", "PRODUCT"],
      api: ["DOMAIN", "PRODUCT"],
      trait: ["TENANT", "DOMAIN"],
      eventSpec: ["PRODUCT"],
    });
  });
});
