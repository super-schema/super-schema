// @vitest-environment node
/**
 * `adminCapabilities`: what the Admin area shows a user, from the policy for the tenant in view. A matrix over who they are: a platform administrator, a tenant
 * administrator (of the tenant in view, of another one), a holder of a domain- or product-scoped administrator role, every other rung of the ladder, and a user
 * with no role. The Admin link and the tabs are decided from these booleans, never from a role name.
 */
import { describe, expect, it } from "vitest";
import { NO_ADMIN_CAPABILITIES, adminCapabilities } from "@/lib/access/capabilities";
import { assign } from "../../../helpers/access-mocks";
import type { Assignment } from "@/lib/access";

const T = "tenant-1";
const OTHER = "tenant-2";

const caps = (assignments: Assignment[], tenantId: string | null = T) => adminCapabilities(assignments, tenantId);
const ALL = { area: true, users: true, domains: true, emitters: true, health: true, classifications: true, git: true, tenants: true };

describe("adminCapabilities", () => {
  it("a platform administrator may use every tab, for any tenant in view", () => {
    expect(caps([assign.global()])).toEqual(ALL);
    expect(caps([assign.global()], OTHER)).toEqual(ALL);
  });

  it("a platform administrator judged over no tenant still holds the platform tabs and the tenant ones (the platform covers every tenant)", () => {
    expect(caps([assign.global()], null)).toEqual(ALL);
  });

  it("a tenant administrator of the tenant in view gets the tenant tabs and none of the platform ones", () => {
    expect(caps([assign.tenant("ADMIN", T)])).toEqual({ area: true, users: true, domains: true, emitters: false, health: false, classifications: false, git: false, tenants: false });
  });

  it("a tenant administrator of ANOTHER tenant has nothing in this one", () => {
    expect(caps([assign.tenant("ADMIN", OTHER)])).toEqual(NO_ADMIN_CAPABILITIES);
    expect(caps([assign.tenant("ADMIN", T)], OTHER)).toEqual(NO_ADMIN_CAPABILITIES);
    expect(caps([assign.tenant("ADMIN", T)], null)).toEqual(NO_ADMIN_CAPABILITIES);
  });

  it("an administrator of a domain or a product reaches no Admin screen (the user and role screens are the tenant administrator's)", () => {
    expect(caps([assign.domain("ADMIN", T, "dom-a")])).toEqual(NO_ADMIN_CAPABILITIES);
    expect(caps([assign.product("ADMIN", T, "dom-a", "prod-a")])).toEqual(NO_ADMIN_CAPABILITIES);
  });

  it.each(["VIEWER", "AUTHOR", "STEWARD", "COMPLIANCE_OFFICER"] as const)("a tenant-wide %s has no admin right at all: no Admin link", (role) => {
    expect(caps([assign.tenant(role, T)])).toEqual(NO_ADMIN_CAPABILITIES);
    expect(caps([assign.tenant(role, T)]).area).toBe(false);
  });

  it("a user with no role has nothing", () => {
    expect(caps([])).toEqual(NO_ADMIN_CAPABILITIES);
  });

  it("holding several roles adds up: a domain administrator who is also a tenant administrator elsewhere has nothing here", () => {
    expect(caps([assign.domain("ADMIN", T, "dom-a"), assign.tenant("ADMIN", OTHER)])).toEqual(NO_ADMIN_CAPABILITIES);
    expect(caps([assign.domain("ADMIN", T, "dom-a"), assign.tenant("ADMIN", T)]).users).toBe(true);
  });

  it("the nothing-allowed value is frozen and says no to everything", () => {
    expect(Object.isFrozen(NO_ADMIN_CAPABILITIES)).toBe(true);
    expect(Object.values(NO_ADMIN_CAPABILITIES).every((value) => value === false)).toBe(true);
  });

  it("`area` is exactly 'some tab beyond personal settings is theirs'", () => {
    for (const assignments of [[assign.global()], [assign.tenant("ADMIN", T)], [assign.tenant("STEWARD", T)], []]) {
      const c = caps(assignments);
      expect(c.area).toBe(c.users || c.domains || c.emitters || c.health || c.classifications || c.git || c.tenants);
    }
  });
});
