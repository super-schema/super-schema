// @vitest-environment node
/**
 * `requirePageAccess` (src/lib/access/page-access.ts): what a PAGE loader asks first. The dashboard layout is not the boundary (Next may not
 * render a layout again on a client navigation), so every page and loader that reads the database decides for itself: the principal and the tenant in
 * view, or the redirect to the "no access yet" screen for a user with no role, a disabled one, a stale session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, roleless, signInAs, signedOut } from "../../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({ redirect: vi.fn(), activeTenant: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/access/principal", async () => (await import("../../../helpers/access-mocks")).principalModule);
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/active-tenant", async () => {
  const { NO_ACCESS_PATH, isNoTenantAccess } = await import("@/lib/access/no-tenant-access");
  return { requireActiveTenantId: mocks.activeTenant, NO_ACCESS_PATH, isNoTenantAccess };
});

import { requirePageAccess } from "@/lib/access/page-access";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeTenant.mockResolvedValue("t1");
});

describe("requirePageAccess", () => {
  it("gives the principal and the tenant in view (asked of the principal already loaded)", async () => {
    const principal = principalOf([assign.tenant("VIEWER", "t1")]);
    signInAs(principal);
    await expect(requirePageAccess()).resolves.toEqual({ principal, tenantId: "t1" });
    expect(mocks.activeTenant).toHaveBeenCalledWith(principal);
  });

  it("a platform administrator is given it too", async () => {
    signInAs(globalAdmin());
    await expect(requirePageAccess()).resolves.toMatchObject({ tenantId: "t1" });
  });

  it("nobody (a disabled user, a user that is gone, no session) is sent to /no-access, and the tenant is not even asked", async () => {
    signedOut();
    await expect(requirePageAccess()).rejects.toThrow("NEXT_REDIRECT /no-access");
    expect(mocks.activeTenant).not.toHaveBeenCalled();
  });

  it("a user with no role goes where the tenant lookup sends them (the redirect to /no-access it raises is not swallowed)", async () => {
    signInAs(roleless());
    mocks.activeTenant.mockImplementation(async () => {
      mocks.redirect("/no-access");
      throw new Error("NEXT_REDIRECT /no-access");
    });
    await expect(requirePageAccess()).rejects.toThrow("NEXT_REDIRECT /no-access");
    expect(mocks.redirect).toHaveBeenCalledWith("/no-access");
  });

  it("does not turn another failure into a redirect (a lost database connection is an error, not 'no access')", async () => {
    signInAs(principalOf([assign.tenant("VIEWER", "t1")]));
    mocks.activeTenant.mockRejectedValue(new Error("connection lost"));
    await expect(requirePageAccess()).rejects.toThrow("connection lost");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
