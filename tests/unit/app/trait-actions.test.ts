import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assign, resetSessionPrincipal } from "../../helpers/access-mocks";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getActiveTenantId: vi.fn(),
  findDomain: vi.fn(),
  createTrait: vi.fn(),
  updateTrait: vi.fn(),
  deleteTrait: vi.fn(),
}));

// The real guard runs (the principal is a platform administrator unless a test says otherwise) and every parent is the active tenant's; the
// role rules are in events-area-access.test.ts, the foreign-tenant ones in events-actions-tenant-guard.test.ts.
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma", domain: { findUnique: h.findDomain } } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/services/events/trait.service", () => ({ createTrait: h.createTrait, updateTrait: h.updateTrait, deleteTrait: h.deleteTrait }));

import { createTraitAction, deleteTraitAction, updateTraitAction } from "@/app/(dashboard)/schemas/trait-actions";

const CTX = { userId: "user-1", userRole: "ADMIN", assignments: [assign.global()], prisma: { tag: "prisma", domain: { findUnique: h.findDomain } } };
const OK = { success: true, data: { id: "t1" } };
const FAIL = { success: false, error: { code: "FORBIDDEN", message: "read-only", details: { x: 1 } } };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue("tenant-active");
  resetSessionPrincipal();
  h.findDomain.mockResolvedValue({ id: "d1", tenantId: "tenant-active" });
});

describe("trait actions", () => {
  it("never trusts a client tenant id for TENANT targets", async () => {
    h.createTrait.mockResolvedValue(OK);
    h.updateTrait.mockResolvedValue(OK);
    h.deleteTrait.mockResolvedValue(OK);
    const input = { name: "CloudEvents", kind: "MESSAGE" as const };
    await createTraitAction({ level: "TENANT", tenantId: "spoofed" }, input);
    expect(h.createTrait).toHaveBeenCalledWith({ level: "TENANT", tenantId: "tenant-active" }, input, CTX);
    await updateTraitAction("t1", { level: "TENANT", tenantId: "spoofed" }, { name: "CloudEvents" });
    expect(h.updateTrait).toHaveBeenCalledWith("t1", { name: "CloudEvents" }, { level: "TENANT", tenantId: "tenant-active" }, CTX);
    await deleteTraitAction("t1", { level: "DOMAIN", domainId: "d1" });
    expect(h.deleteTrait).toHaveBeenCalledWith("t1", { level: "DOMAIN", domainId: "d1" }, CTX);
    expect(h.revalidatePath).toHaveBeenCalledTimes(3);
  });

  it("rejects unauthenticated calls with NOT_AUTHENTICATED: no service call, no tenant lookup, no revalidate", async () => {
    h.auth.mockResolvedValue(null);
    const notAuthenticated = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" };
    const input = { name: "CloudEvents", kind: "MESSAGE" as const };
    expect(await createTraitAction({ level: "TENANT", tenantId: "t" }, input)).toEqual(notAuthenticated);
    expect(await updateTraitAction("t1", { level: "DOMAIN", domainId: "d1" }, { name: "x" })).toEqual(notAuthenticated);
    expect(await deleteTraitAction("t1", { level: "DOMAIN", domainId: "d1" })).toEqual(notAuthenticated);
    for (const fn of [h.createTrait, h.updateTrait, h.deleteTrait, h.getActiveTenantId, h.revalidatePath]) expect(fn).not.toHaveBeenCalled();
  });

  it("returns service failures with code + details and does not revalidate", async () => {
    for (const fn of [h.createTrait, h.updateTrait, h.deleteTrait]) fn.mockResolvedValue(FAIL);
    const expected = { success: false, error: "read-only", code: "FORBIDDEN", details: { x: 1 } };
    expect(await createTraitAction({ level: "DOMAIN", domainId: "d1" }, { name: "x", kind: "OPERATION" })).toEqual(expected);
    expect(await updateTraitAction("t1", { level: "DOMAIN", domainId: "d1" }, { name: "x" })).toEqual(expected);
    expect(await deleteTraitAction("t1", { level: "DOMAIN", domainId: "d1" })).toEqual(expected);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers a malformed target as a missing one, whatever it is, and the service never runs (fail closed)", async () => {
    h.createTrait.mockResolvedValue(OK);
    for (const bad of [null, undefined, "x", 5, {}, { level: "DOMAIN" }, { level: "PRODUCT", productId: 5 }, { level: "DOMAIN", domainId: "" }]) {
      expect(await createTraitAction(bad as never, { name: "x", kind: "MESSAGE" }), JSON.stringify(bad)).toEqual({ success: false, error: "Target not found", code: "NOT_FOUND" });
    }
    expect(h.createTrait).not.toHaveBeenCalled();
    expect(h.findDomain).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("database error hygiene (the trait detail-page forms render whatever these return)", () => {
  const GENERIC = "Something went wrong. Try again; if it keeps happening, contact an administrator.";
  const RAW = 'insert or update on table "traits" violates foreign key constraint "traits_headers_entity_id_fkey"';
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => consoleError.mockRestore());

  it("turns a DB_ERROR or a thrown error from any trait action into a generic message, logged server-side, without revalidating", async () => {
    const dbFailure = { success: false, error: { code: "DB_ERROR", message: RAW } };
    for (const fn of [h.createTrait, h.updateTrait, h.deleteTrait]) fn.mockResolvedValue(dbFailure);
    const generic = { success: false, error: GENERIC, code: "DB_ERROR" };
    const results = [
      await createTraitAction({ level: "DOMAIN", domainId: "d1" }, { name: "x", kind: "OPERATION" }),
      await updateTraitAction("t1", { level: "DOMAIN", domainId: "d1" }, { name: "x" }),
      await deleteTraitAction("t1", { level: "DOMAIN", domainId: "d1" }),
    ];
    for (const r of results) expect(r).toEqual(generic);
    expect(JSON.stringify(results)).not.toContain("traits_headers_entity_id_fkey");
    expect(consoleError).toHaveBeenCalledWith("[updateTraitAction] database error", RAW);
    expect(consoleError).toHaveBeenCalledWith("[deleteTraitAction] database error", RAW);

    const thrown = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    h.updateTrait.mockRejectedValueOnce(thrown);
    expect(await updateTraitAction("t1", { level: "DOMAIN", domainId: "d1" }, { name: "x" })).toEqual({ success: false, error: GENERIC, code: "INTERNAL_ERROR" });
    expect(consoleError).toHaveBeenCalledWith("[updateTraitAction] unexpected error", thrown);
    h.getActiveTenantId.mockRejectedValueOnce(thrown);
    expect(await updateTraitAction("t1", { level: "TENANT", tenantId: "t" }, { name: "x" })).toEqual({ success: false, error: GENERIC, code: "INTERNAL_ERROR" });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes ownership, conflict and validation failures through untouched (suggested fix and all)", async () => {
    for (const code of ["FORBIDDEN", "NOT_FOUND", "CONFLICT", "VALIDATION_ERROR"]) {
      h.updateTrait.mockResolvedValueOnce({ success: false, error: { code, message: code, suggestedFix: "fix it" } });
      expect(await updateTraitAction("t1", { level: "DOMAIN", domainId: "d1" }, { name: "x" })).toEqual({ success: false, error: code, code, suggestedFix: "fix it" });
      h.deleteTrait.mockResolvedValueOnce({ success: false, error: { code, message: code, suggestedFix: "fix it" } });
      expect(await deleteTraitAction("t1", { level: "DOMAIN", domainId: "d1" })).toEqual({ success: false, error: code, code, suggestedFix: "fix it" });
    }
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
