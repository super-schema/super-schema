// @vitest-environment node
/**
 * The Admin layout is decided on the server (`src/app/(dashboard)/admin/layout.tsx`): it asks who is looking and which tenant is in view, and hands the
 * shell the capabilities the policy gives them for that tenant. A person with no role never gets as far as the shell (the "no access yet" screen); everyone
 * else gets exactly the capabilities their roles give, so the tabs shown are the tabs they may use. The matrix: platform administrator, tenant administrator
 * (of the tenant in view, of another), a domain-scoped administrator, the other rungs, and no role. (How the shell draws them: admin-shell.test.tsx.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_ADMIN_CAPABILITIES } from "@/lib/access/capabilities";
import { assign, globalAdmin, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({ redirect: vi.fn(), activeTenant: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
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
vi.mock("@/components/custom/admin/AdminShell", () => ({ AdminShell: () => null }));

import AdminLayout from "@/app/(dashboard)/admin/layout";

const capabilitiesOf = async () => (await AdminLayout({ children: "page" })).props.capabilities;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeTenant.mockResolvedValue("tenant-1");
});

describe("the Admin layout", () => {
  it("a platform administrator gets every tab", async () => {
    signInAs(globalAdmin());
    expect(await capabilitiesOf()).toMatchObject({ area: true, users: true, domains: true, emitters: true, health: true, classifications: true });
  });

  it("a tenant administrator of the tenant in view gets the tenant tabs and none of the platform ones", async () => {
    signInAs(tenantMember("ADMIN", "tenant-1"));
    expect(await capabilitiesOf()).toMatchObject({ area: true, users: true, domains: true, emitters: false, health: false, classifications: false, git: false, tenants: false });
  });

  it("an administrator of another tenant, a domain-scoped administrator and every other rung get nothing of the area", async () => {
    for (const assignments of [
      [assign.tenant("ADMIN", "tenant-2")],
      [assign.domain("ADMIN", "tenant-1", "dom-a")],
      [assign.tenant("VIEWER", "tenant-1")],
      [assign.tenant("AUTHOR", "tenant-1")],
      [assign.tenant("STEWARD", "tenant-1")],
      [assign.tenant("COMPLIANCE_OFFICER", "tenant-1")],
    ]) {
      signInAs(principalOf(assignments));
      expect(await capabilitiesOf(), JSON.stringify(assignments)).toEqual(NO_ADMIN_CAPABILITIES);
    }
  });

  it("a person with no role, a disabled one and a session that is gone are sent to /no-access: the shell is not even built", async () => {
    signInAs(roleless());
    mocks.activeTenant.mockImplementation(async () => {
      mocks.redirect("/no-access");
      throw new Error("NEXT_REDIRECT /no-access");
    });
    await expect(AdminLayout({ children: "page" })).rejects.toThrow("NEXT_REDIRECT /no-access");
    mocks.activeTenant.mockResolvedValue("tenant-1");
    signedOut();
    await expect(AdminLayout({ children: "page" })).rejects.toThrow("NEXT_REDIRECT /no-access");
    expect(mocks.redirect).toHaveBeenCalledWith("/no-access");
  });

  it("the capabilities are judged for the tenant IN VIEW, whatever else the person holds", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", "tenant-1"), assign.tenant("VIEWER", "tenant-2")]));
    mocks.activeTenant.mockResolvedValue("tenant-2");
    expect(await capabilitiesOf()).toEqual(NO_ADMIN_CAPABILITIES);
    mocks.activeTenant.mockResolvedValue("tenant-1");
    expect((await capabilitiesOf()).users).toBe(true);
  });
});
