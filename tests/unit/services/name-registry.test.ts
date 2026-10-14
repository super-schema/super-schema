import { describe, it, expect } from "vitest";
import { inSameLine, findLineConflict, type NamedAsset } from "@/services/name-registry.service";

const T = "t1";
const asset = (over: Partial<NamedAsset>): NamedAsset => ({
  kind: "entity", id: "x", name: "Order", tenantId: T, domainId: null, productId: null, ...over,
});

describe("inSameLine", () => {
  it("tenant is in line with everything in the tenant", () => {
    expect(inSameLine(asset({}), asset({ domainId: "d1", productId: "p1" }))).toBe(true);
  });
  it("domain is in line with its products but not sibling domains", () => {
    expect(inSameLine(asset({ domainId: "d1" }), asset({ domainId: "d1", productId: "p1" }))).toBe(true);
    expect(inSameLine(asset({ domainId: "d1" }), asset({ domainId: "d2" }))).toBe(false);
  });
  it("sibling products are not in line", () => {
    expect(inSameLine(asset({ domainId: "d1", productId: "p1" }), asset({ domainId: "d1", productId: "p2" }))).toBe(false);
  });
  it("different tenants never conflict", () => {
    expect(inSameLine(asset({}), asset({ tenantId: "t2" }))).toBe(false);
  });
});

describe("findLineConflict", () => {
  it("detects cross-kind, case-insensitive conflicts", () => {
    const existing = [asset({ kind: "sharedEnum", id: "e1", name: "order", domainId: "d1" })];
    const hit = findLineConflict({ name: "Order", tenantId: T, domainId: "d1", productId: "p1" }, existing);
    expect(hit?.id).toBe("e1");
  });
  it("ignores the excluded asset (rename of itself)", () => {
    const existing = [asset({ id: "e1", name: "Order", domainId: "d1", productId: "p1" })];
    const hit = findLineConflict(
      { name: "Order", tenantId: T, domainId: "d1", productId: "p1", exclude: { kind: "entity", id: "e1" } },
      existing
    );
    expect(hit).toBeNull();
  });
  it("allows the same name in a sibling product", () => {
    const existing = [asset({ id: "e1", domainId: "d1", productId: "p1" })];
    expect(findLineConflict({ name: "Order", tenantId: T, domainId: "d1", productId: "p2" }, existing)).toBeNull();
  });
});
