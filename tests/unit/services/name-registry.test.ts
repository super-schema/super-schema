import { describe, it, expect } from "vitest";
import {
  inSameLine,
  findLineConflict,
  groupLineConflicts,
  assertNameAvailable,
  type NamedAsset,
} from "@/services/name-registry.service";
import { emptyRegistryDelegates } from "../../helpers/registry-mocks";

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

describe("groupLineConflicts", () => {
  it("reports a cross-kind, case-insensitive clash within one line", () => {
    const all = [
      asset({ kind: "entity", id: "a", name: "Order", domainId: "d1", productId: "p1" }),
      asset({ kind: "sharedEnum", id: "b", name: "order", domainId: "d1" }),
    ];
    const groups = groupLineConflicts(all);
    expect(groups).toHaveLength(1);
    expect(groups[0].assets.map((a) => a.id).sort()).toEqual(["a", "b"]);
  });
  it("does not report the same name in sibling products", () => {
    const all = [
      asset({ id: "a", domainId: "d1", productId: "p1" }),
      asset({ id: "b", domainId: "d1", productId: "p2" }),
    ];
    expect(groupLineConflicts(all)).toEqual([]);
  });
  it("does not report the same name in sibling domains", () => {
    const all = [
      asset({ id: "a", domainId: "d1" }),
      asset({ id: "b", domainId: "d2" }),
    ];
    expect(groupLineConflicts(all)).toEqual([]);
  });
  it("reports only the in-line members of a 3-asset group", () => {
    const all = [
      asset({ kind: "entity", id: "a", domainId: "d1", productId: "p1" }),
      asset({ kind: "sharedEnum", id: "b", name: "ORDER", domainId: "d1" }),
      asset({ kind: "entity", id: "c", domainId: "d2", productId: "p9" }),
    ];
    const groups = groupLineConflicts(all);
    expect(groups).toHaveLength(1);
    expect(groups[0].assets.map((a) => a.id).sort()).toEqual(["a", "b"]);
  });
  it("ignores names that appear only once", () => {
    expect(groupLineConflicts([asset({ id: "a" }), asset({ id: "b", name: "Customer" })])).toEqual([]);
  });
});

describe("assertNameAvailable", () => {
  const candidate = { name: "Order", tenantId: T, domainId: "d1", productId: null };
  const fakeDb = (over: Record<string, unknown> = {}) =>
    ({ ...emptyRegistryDelegates(), ...over }) as never;

  it("returns ok when nothing in the line uses the name", async () => {
    const res = await assertNameAvailable(fakeDb(), candidate);
    expect(res.success).toBe(true);
  });
  it("returns NAME_CONFLICT with the clashing asset tagged by its kind", async () => {
    const row = { id: "s1", name: "order", tenantId: T, domainId: "d1", productId: "p1" };
    const db = fakeDb({ serviceDefinition: { findMany: () => Promise.resolve([row]) } });
    const res = await assertNameAvailable(db, candidate);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("NAME_CONFLICT");
    expect(res.error.message).toContain('API "order"');
    expect(res.error.message).toContain("Product level");
    expect((res.error.details as { conflict: NamedAsset }).conflict).toMatchObject({ kind: "service", id: "s1" });
  });
  it("returns DB_ERROR instead of rejecting when a query fails", async () => {
    const db = fakeDb({ sharedEnum: { findMany: () => Promise.reject(new Error("connection reset")) } });
    const res = await assertNameAvailable(db, candidate);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatchObject({ code: "DB_ERROR", message: "connection reset" });
  });
  it("falls back to a generic DB_ERROR message for non-Error rejections", async () => {
    const db = fakeDb({ entity: { findMany: () => Promise.reject("boom") } });
    const res = await assertNameAvailable(db, candidate);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toMatchObject({ code: "DB_ERROR", message: "Failed to check name availability" });
  });
});
