import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getActiveTenantId: vi.fn(),
  resolveCurrentUserId: vi.fn(),
  loadPinnableVersions: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "VIEWER" }) }));
vi.mock("@/features/events/load-options", () => ({ loadPinnableVersions: h.loadPinnableVersions }));

import { listPinnableVersionsAction } from "@/features/events/pin-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue("tenant-active");
  h.resolveCurrentUserId.mockResolvedValue("user-1");
});

describe("listPinnableVersionsAction", () => {
  it("rejects unauthenticated calls without resolving a tenant or touching the database", async () => {
    h.auth.mockResolvedValue(null);
    const r = await listPinnableVersionsAction("e1");
    expect(r).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(h.getActiveTenantId).not.toHaveBeenCalled();
    expect(h.loadPinnableVersions).not.toHaveBeenCalled();
  });

  it("treats a stale session (user row gone) as unauthenticated", async () => {
    const { AuditUserMissingError } = await import("@/lib/audit");
    h.resolveCurrentUserId.mockRejectedValue(new AuditUserMissingError("gone"));
    expect(await listPinnableVersionsAction("e1")).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(h.loadPinnableVersions).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the server-resolved active tenant, never to anything client-supplied", async () => {
    h.loadPinnableVersions.mockResolvedValue([{ id: "v2", label: "1.1" }, { id: "v1", label: "1.0" }]);
    const r = await listPinnableVersionsAction("e1");
    expect(r).toEqual({ success: true, data: [{ id: "v2", label: "1.1" }, { id: "v1", label: "1.0" }] });
    expect(h.loadPinnableVersions).toHaveBeenCalledWith("tenant-active", "e1");
    expect(h.getActiveTenantId).toHaveBeenCalledTimes(1);
  });

  it("returns NOT_FOUND for an entity outside the active tenant (or unknown), indistinguishably", async () => {
    h.loadPinnableVersions.mockResolvedValue(null);
    const r = await listPinnableVersionsAction("foreign-entity");
    expect(r).toEqual({ success: false, error: "Entity not found", code: "NOT_FOUND" });
  });

  it("is read-only: never revalidates", async () => {
    h.loadPinnableVersions.mockResolvedValue([]);
    await listPinnableVersionsAction("e1");
    await listPinnableVersionsAction("missing");
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("never leaks database error text to the client", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.loadPinnableVersions.mockRejectedValue(new Error('relation "entities" does not exist (SELECT secret FROM x)'));
    const r = await listPinnableVersionsAction("e1");
    expect(r).toEqual({ success: false, error: "Could not load versions", code: "INTERNAL_ERROR" });
    expect(JSON.stringify(r)).not.toMatch(/relation|SELECT|secret/);
    expect(spy).toHaveBeenCalled(); // the detail is logged server-side
    spy.mockRestore();
  });

  it("returns a generic failure when the tenant cannot be resolved", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.getActiveTenantId.mockRejectedValue(new Error("cookie store exploded"));
    expect(await listPinnableVersionsAction("e1")).toMatchObject({ success: false, code: "INTERNAL_ERROR" });
    spy.mockRestore();
  });
});
