import { describe, it, expect, vi, beforeEach } from "vitest";
import { assign, resetSessionPrincipal, sessionPrincipalModule, setSessionPrincipal } from "../../helpers/access-mocks";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getActiveTenantId: vi.fn(),
  loadPinnableVersions: vi.fn(),
  entityLookup: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { entity: { findUnique: h.entityLookup } } }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/features/events/load-options", () => ({ loadPinnableVersions: h.loadPinnableVersions }));

import { listPinnableVersionsAction } from "@/features/events/pin-actions";

const entityIn = (tenantId: string, domainId: string | null = null) => ({ tenantId, domainId, productId: null, product: null });

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionPrincipal();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue("tenant-active");
  h.entityLookup.mockResolvedValue(entityIn("tenant-active"));
});

describe("listPinnableVersionsAction", () => {
  it("rejects unauthenticated calls without resolving a tenant or touching the database", async () => {
    h.auth.mockResolvedValue(null);
    const r = await listPinnableVersionsAction("e1");
    expect(r).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(h.getActiveTenantId).not.toHaveBeenCalled();
    expect(h.entityLookup).not.toHaveBeenCalled();
    expect(h.loadPinnableVersions).not.toHaveBeenCalled();
  });

  it("treats a user who is nobody (a stale session, a disabled user) as unauthenticated", async () => {
    sessionPrincipalModule.getPrincipal.mockResolvedValueOnce(null);
    expect(await listPinnableVersionsAction("e1")).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(h.loadPinnableVersions).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the active tenant the entity was judged in, never to anything client-supplied", async () => {
    h.loadPinnableVersions.mockResolvedValue([{ id: "v2", label: "1.1" }, { id: "v1", label: "1.0" }]);
    const r = await listPinnableVersionsAction("e1");
    expect(r).toEqual({ success: true, data: [{ id: "v2", label: "1.1" }, { id: "v1", label: "1.0" }] });
    expect(h.loadPinnableVersions).toHaveBeenCalledWith("tenant-active", "e1");
    expect(h.getActiveTenantId).toHaveBeenCalledTimes(1);
  });

  it("returns NOT_FOUND for an entity outside the active tenant (or unknown), indistinguishably, and loads nothing", async () => {
    h.entityLookup.mockResolvedValueOnce(entityIn("another-tenant"));
    const foreign = await listPinnableVersionsAction("foreign-entity");
    h.entityLookup.mockResolvedValueOnce(null);
    const missing = await listPinnableVersionsAction("no-such-entity");
    expect(foreign).toEqual({ success: false, error: "Entity not found", code: "NOT_FOUND" });
    expect(JSON.stringify(missing)).toBe(JSON.stringify(foreign));
    expect(h.loadPinnableVersions).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the loader finds no such entity in the tenant", async () => {
    h.loadPinnableVersions.mockResolvedValue(null);
    expect(await listPinnableVersionsAction("e1")).toEqual({ success: false, error: "Entity not found", code: "NOT_FOUND" });
  });

  it("pinning a schema into an event is an author's act (event.pin): a viewer is refused, an author is not", async () => {
    h.loadPinnableVersions.mockResolvedValue([]);
    setSessionPrincipal([assign.tenant("VIEWER", "tenant-active")]);
    expect(await listPinnableVersionsAction("e1")).toEqual({ success: false, error: "You do not have permission to do this", code: "FORBIDDEN" });
    expect(h.loadPinnableVersions).not.toHaveBeenCalled();
    setSessionPrincipal([assign.tenant("AUTHOR", "tenant-active")]);
    expect(await listPinnableVersionsAction("e1")).toMatchObject({ success: true });
  });

  it("a user with no role at all and an author of a SIBLING domain get the not-found of a missing entity", async () => {
    setSessionPrincipal([]);
    const nobody = await listPinnableVersionsAction("e1");
    setSessionPrincipal([assign.domain("AUTHOR", "tenant-active", "dom-b")]);
    h.entityLookup.mockResolvedValue(entityIn("tenant-active", "dom-a"));
    const sibling = await listPinnableVersionsAction("e1");
    expect(nobody).toEqual({ success: false, error: "Entity not found", code: "NOT_FOUND" });
    expect(JSON.stringify(sibling)).toBe(JSON.stringify(nobody));
    expect(h.loadPinnableVersions).not.toHaveBeenCalled();
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
