// @vitest-environment node
/**
 * `getDomainsAction` and `createDomainAction` (schemas/actions.ts) ask the policy first. The Domains page used to list EVERY tenant's domains to
 * any signed-in user (`prisma.domain.findMany` with no `where`): it lists the ACTIVE tenant's, and only the domains the caller's roles cover.
 * Making a domain is a tenant-level steward's act (`domain.create`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, resetSessionPrincipal, setSessionPrincipal } from "../../helpers/access-mocks";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  activeTenant: vi.fn(),
  findMany: vi.fn(),
  entityCount: vi.fn(),
  createDomainRow: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { domain: { findMany: h.findMany }, entity: { count: h.entityCount } } }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/services/domain-row.service", () => ({ createDomainRow: h.createDomainRow }));

import { createDomainAction, getDomainsAction } from "@/app/(dashboard)/schemas/actions";

const T = "tenant-1";
const DOMAINS = [
  { id: "dom-a", tenantId: T, name: "A", isSystem: false, _count: { entities: 1 } },
  { id: "dom-b", tenantId: T, name: "B", isSystem: false, _count: { entities: 2 } },
];
const form = (name = "Payments") => {
  const fd = new FormData();
  fd.set("name", name);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionPrincipal();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.activeTenant.mockResolvedValue(T);
  h.findMany.mockResolvedValue(DOMAINS);
  h.createDomainRow.mockResolvedValue({ success: true, data: { id: "dom-new" } });
});

describe("getDomainsAction", () => {
  it("answers nobody signed in 'Not authenticated' and reads nothing", async () => {
    h.auth.mockResolvedValue(null);
    expect(await getDomainsAction()).toEqual({ error: "Not authenticated" });
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("reads only the ACTIVE tenant's domains (never another tenant's)", async () => {
    await getDomainsAction();
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: T } }));
  });

  it("a user with no role gets nothing and the database is not asked", async () => {
    setSessionPrincipal([]);
    expect(await getDomainsAction()).toEqual({ error: "Domains not found" });
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("a role in another tenant gives nothing here", async () => {
    setSessionPrincipal([assign.tenant("ADMIN", "tenant-2")]);
    expect(await getDomainsAction()).toEqual({ error: "Domains not found" });
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("a tenant-wide role lists every domain of the tenant, a platform administrator too", async () => {
    for (const assignments of [[assign.tenant("VIEWER", T)], [assign.global()]]) {
      setSessionPrincipal(assignments);
      expect(await getDomainsAction()).toEqual(DOMAINS);
    }
  });

  it("a domain-scoped role lists ITS domain and not its siblings", async () => {
    setSessionPrincipal([assign.domain("VIEWER", T, "dom-a")]);
    expect(await getDomainsAction()).toEqual([DOMAINS[0]]);
  });

  it("a PRODUCT-scoped role lists the domain of its product as the way to it (not a sibling domain), counting only its own product's entities", async () => {
    h.entityCount.mockResolvedValue(1);
    setSessionPrincipal([assign.product("VIEWER", T, "dom-a", "prod-a")]);
    expect(await getDomainsAction()).toEqual([{ ...DOMAINS[0], _count: { entities: 1 } }]);
    // The count is of the products the caller's roles reach, in that domain of the active tenant, never the domain's whole total.
    expect(h.entityCount).toHaveBeenCalledWith({ where: { tenantId: T, domainId: "dom-a", productId: { in: ["prod-a"] } } });
  });

  it("a user holding the whole domain AND a product of it sees the domain whole (no narrowed count)", async () => {
    setSessionPrincipal([assign.domain("VIEWER", T, "dom-a"), assign.product("AUTHOR", T, "dom-a", "prod-a")]);
    expect(await getDomainsAction()).toEqual([DOMAINS[0]]);
    expect(h.entityCount).not.toHaveBeenCalled();
  });

  it("a product role of another tenant lists nothing here", async () => {
    setSessionPrincipal([assign.product("VIEWER", "tenant-2", "dom-a", "prod-a")]);
    expect(await getDomainsAction()).toEqual({ error: "Domains not found" });
    expect(h.findMany).not.toHaveBeenCalled();
  });
});

describe("createDomainAction", () => {
  it("answers nobody signed in 'You must be logged in' and creates nothing", async () => {
    h.auth.mockResolvedValue(null);
    expect(await createDomainAction(form())).toEqual({ error: "You must be logged in" });
    expect(h.createDomainRow).not.toHaveBeenCalled();
  });

  it("a user with no role, a viewer and an author cannot (a steward's act): nothing is created", async () => {
    setSessionPrincipal([]);
    expect(await createDomainAction(form())).toEqual({ error: "Tenant not found" });
    for (const role of ["VIEWER", "AUTHOR"] as const) {
      setSessionPrincipal([assign.tenant(role, T)]);
      expect(await createDomainAction(form()), role).toEqual({ error: "You do not have permission to do this" });
    }
    expect(h.createDomainRow).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("a steward, compliance officer and administrator of the tenant can, and so can a platform administrator", async () => {
    for (const assignments of [[assign.tenant("STEWARD", T)], [assign.tenant("COMPLIANCE_OFFICER", T)], [assign.tenant("ADMIN", T)], [assign.global()]]) {
      setSessionPrincipal(assignments);
      expect(await createDomainAction(form()), JSON.stringify(assignments)).toEqual({ success: true });
    }
    expect(h.createDomainRow).toHaveBeenCalledTimes(4);
    expect(h.createDomainRow).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), expect.anything());
  });

  it("a STEWARD of one domain only does not hold the tenant level: refused", async () => {
    setSessionPrincipal([assign.domain("STEWARD", T, "dom-a")]);
    expect(await createDomainAction(form())).toEqual({ error: "You do not have permission to do this" });
    expect(h.createDomainRow).not.toHaveBeenCalled();
  });

  it("a steward of another tenant than the one in view cannot create a domain here", async () => {
    setSessionPrincipal([assign.tenant("ADMIN", "tenant-2")]);
    expect(await createDomainAction(form())).toEqual({ error: "Tenant not found" });
    expect(h.createDomainRow).not.toHaveBeenCalled();
  });
});
