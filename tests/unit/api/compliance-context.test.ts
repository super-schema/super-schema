// @vitest-environment node
/**
 * The service context of a compliance request is the signed-in PRINCIPAL's (the user and the assignments the compliance service judges), plus the
 * tenant in view: never the platform role label. Nobody signed in is 401, a user who may reach no tenant is the usual `Not found`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

const h = vi.hoisted(() => ({ activeTenant: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { resolveContext } from "@/app/api/compliance/_context";
import { NoTenantAccess } from "@/lib/access/no-tenant-access";

beforeEach(() => {
  vi.clearAllMocks();
  h.activeTenant.mockResolvedValue("tenant-1");
});

describe("resolveContext", () => {
  it("is 401 for nobody signed in, a disabled user or a stale session (no principal)", async () => {
    signedOut();
    expect(await resolveContext()).toEqual({ ok: false, status: 401, message: "Not authenticated" });
    expect(h.activeTenant).not.toHaveBeenCalled();
  });

  it("carries the principal's user and assignments and the tenant in view", async () => {
    const assignments = [assign.tenant("COMPLIANCE_OFFICER", "tenant-1")];
    signInAs(principalOf(assignments, { userId: "u-7" }));
    const result = await resolveContext();
    expect(result).toEqual({ ok: true, ctx: expect.objectContaining({ userId: "u-7", assignments, tenantId: "tenant-1" }) });
  });

  it("asks the tenant of the principal it already holds (no second principal read)", async () => {
    const principal = tenantMember("VIEWER", "tenant-1");
    signInAs(principal);
    await resolveContext();
    expect(h.activeTenant).toHaveBeenCalledWith(principal);
  });

  it("a user who may reach no tenant at all gets the usual not-found, not a server error", async () => {
    signInAs(roleless());
    h.activeTenant.mockRejectedValue(new NoTenantAccess());
    expect(await resolveContext()).toEqual({ ok: false, status: 404, message: "Not found" });
  });

  it("any other failure of the tenant look-up is not turned into an answer", async () => {
    signInAs(tenantMember("ADMIN", "tenant-1"));
    h.activeTenant.mockRejectedValue(new Error("connection lost"));
    await expect(resolveContext()).rejects.toThrow("connection lost");
  });
});
