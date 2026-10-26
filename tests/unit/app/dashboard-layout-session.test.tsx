// @vitest-environment node
/**
 * Defence in depth behind the middleware (tests/unit/middleware.test.ts): the dashboard layout itself asks Auth.js for the session
 * and sends a visitor without one to /login, so a page of the dashboard is never rendered for a request that got past the middleware
 * (a misconfigured matcher, a future change of the middleware) without a session. A signed-in user who may access no tenant (no role yet,
 * a disabled account, a session whose user is gone) is sent to /no-access instead of an empty app. It also tells the shell whether the Admin link is
 * the person's: from the policy's reading of their roles for the tenant in view, never from a role name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoTenantAccess } from "@/lib/access/no-tenant-access";
import { assign, globalAdmin, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), redirect: vi.fn(), activeTenant: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/active-tenant", async () => {
  const { NO_ACCESS_PATH, isNoTenantAccess } = await import("@/lib/access/no-tenant-access");
  return { getActiveTenantId: mocks.activeTenant, NO_ACCESS_PATH, isNoTenantAccess };
});
vi.mock("@/components/layout/DashboardClientShell", () => ({ DashboardClientShell: () => null }));

import DashboardLayout from "@/app/(dashboard)/layout";

const SESSION = { user: { id: "u1", email: "a@b.c" }, expires: "2999-01-01" };
const adminAreaOf = async () => (await DashboardLayout({ children: "page" })).props.adminArea;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeTenant.mockResolvedValue("tenant-1");
  signInAs(globalAdmin());
});

describe("the dashboard layout", () => {
  it("redirects to /login when there is no session, and renders nothing of the dashboard", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(DashboardLayout({ children: "secret" })).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
    expect(mocks.activeTenant).not.toHaveBeenCalled();
  });

  it("redirects when the session has no user", async () => {
    mocks.auth.mockResolvedValue({ expires: "2999-01-01" });
    await expect(DashboardLayout({ children: "secret" })).rejects.toThrow("NEXT_REDIRECT /login");
  });

  it("renders the shell around the page for a session with a user who may access a tenant", async () => {
    mocks.auth.mockResolvedValue(SESSION);
    const element = await DashboardLayout({ children: "page" });
    expect(element).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("sends a signed-in user who may access no tenant to /no-access, and renders nothing of the dashboard", async () => {
    mocks.auth.mockResolvedValue(SESSION);
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    await expect(DashboardLayout({ children: "secret" })).rejects.toThrow("NEXT_REDIRECT /no-access");
    expect(mocks.redirect).toHaveBeenCalledWith("/no-access");
  });

  it("does not turn another failure into a redirect (a lost database connection is an error, not 'no access')", async () => {
    mocks.auth.mockResolvedValue(SESSION);
    mocks.activeTenant.mockRejectedValue(new Error("connection lost"));
    await expect(DashboardLayout({ children: "secret" })).rejects.toThrow("connection lost");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("the Admin link is shown to the people who administer the tenant in view or the platform, and to nobody else", () => {
  beforeEach(() => mocks.auth.mockResolvedValue(SESSION));

  it("a platform administrator and a tenant administrator of the tenant in view: yes", async () => {
    signInAs(globalAdmin());
    expect(await adminAreaOf()).toBe(true);
    signInAs(tenantMember("ADMIN", "tenant-1"));
    expect(await adminAreaOf()).toBe(true);
  });

  it("an administrator of ANOTHER tenant, a domain-scoped administrator, every other rung, and a person with no role: no", async () => {
    signInAs(tenantMember("ADMIN", "tenant-2"));
    expect(await adminAreaOf()).toBe(false);
    signInAs(principalOf([assign.domain("ADMIN", "tenant-1", "dom-a")]));
    expect(await adminAreaOf()).toBe(false);
    for (const role of ["VIEWER", "AUTHOR", "STEWARD", "COMPLIANCE_OFFICER"] as const) {
      signInAs(tenantMember(role, "tenant-1"));
      expect(await adminAreaOf(), role).toBe(false);
    }
    signInAs(roleless());
    expect(await adminAreaOf()).toBe(false);
  });

  it("a session whose user is nobody (disabled, gone) is not shown it either", async () => {
    signedOut();
    expect(await adminAreaOf()).toBe(false);
  });
});
