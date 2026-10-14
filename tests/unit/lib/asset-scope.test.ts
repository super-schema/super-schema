import { describe, it, expect, vi } from "vitest";
import { resolveScope } from "@/lib/asset-scope";

const db = {
  domain: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "d1" ? { id: "d1", tenantId: "t1" } : null)) },
  product: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "p1" ? { id: "p1", domainId: "d1", domain: { tenantId: "t1" } } : null)) },
};

describe("resolveScope", () => {
  it("resolves product → domain → tenant", async () => {
    const r = await resolveScope(db as never, { level: "PRODUCT", productId: "p1" });
    expect(r.success && r.data).toEqual({ tenantId: "t1", domainId: "d1", productId: "p1" });
  });
  it("resolves domain", async () => {
    const r = await resolveScope(db as never, { level: "DOMAIN", domainId: "d1" });
    expect(r.success && r.data).toEqual({ tenantId: "t1", domainId: "d1", productId: null });
  });
  it("resolves tenant", async () => {
    const r = await resolveScope(db as never, { level: "TENANT", tenantId: "t1" });
    expect(r.success && r.data).toEqual({ tenantId: "t1", domainId: null, productId: null });
  });
  it("NOT_FOUND for unknown product", async () => {
    const r = await resolveScope(db as never, { level: "PRODUCT", productId: "nope" });
    expect(!r.success && r.error.code).toBe("NOT_FOUND");
  });
  it("NOT_FOUND for unknown domain", async () => {
    const r = await resolveScope(db as never, { level: "DOMAIN", domainId: "nope" });
    expect(!r.success && r.error.code).toBe("NOT_FOUND");
  });
});
