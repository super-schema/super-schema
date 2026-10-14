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
    expect(validateScope("message", { tenantId: t, domainId: "d", productId: null }).success).toBe(false);
    expect(validateScope("trait", { tenantId: t, domainId: null, productId: null }).success).toBe(true);
  });
  it("matrix matches spec §4.1", () => {
    expect(ALLOWED_LEVELS).toEqual({
      dataType: ["TENANT", "DOMAIN", "PRODUCT"],
      entity: ["TENANT", "PRODUCT"],
      api: ["DOMAIN", "PRODUCT"],
      trait: ["TENANT", "DOMAIN", "PRODUCT"],
      message: ["PRODUCT"],
      channel: ["PRODUCT"],
      eventSpec: ["PRODUCT"],
    });
  });
});
