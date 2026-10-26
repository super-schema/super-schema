// @vitest-environment node
/**
 * `setActiveTenantAction`: the cookie only ever names a tenant the user may access, and a refusal answers EXACTLY as a tenant that does not
 * exist does (a user must not learn which tenants exist by trying ids).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  revalidatePath: vi.fn(),
  prisma: { tenant: { findUnique: vi.fn() } },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.cookieSet }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);

import { setActiveTenantAction } from "@/app/(dashboard)/schemas/tenant-actions";

const exists = (id: string) => mocks.prisma.tenant.findUnique.mockImplementation(async (args: { where: { id: string } }) => (args.where.id === id ? { id } : null));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.tenant.findUnique.mockResolvedValue(null);
});

describe("setActiveTenantAction", () => {
  it("answers 'You must be logged in' to nobody, and sets nothing", async () => {
    signedOut();
    expect(await setActiveTenantAction("t1")).toEqual({ error: "You must be logged in" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("switches to a tenant the user holds a role in: sets the cookie and revalidates", async () => {
    signInAs(principalOf([assign.tenant("VIEWER", "t1"), assign.domain("AUTHOR", "t2", "d2")]));
    exists("t2");
    expect(await setActiveTenantAction("t2")).toEqual({ success: true });
    expect(mocks.cookieSet).toHaveBeenCalledWith("active_tenant", "t2", expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/schemas");
  });

  it("a global administrator may switch to any tenant that exists", async () => {
    signInAs(globalAdmin());
    exists("any-tenant");
    expect(await setActiveTenantAction("any-tenant")).toEqual({ success: true });
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
  });

  it("refuses a user with no role at all, and sets nothing", async () => {
    signInAs(roleless());
    exists("t1");
    expect(await setActiveTenantAction("t1")).toEqual({ error: "Tenant not found" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a tenant the user holds no role in, with the very answer a missing tenant gets", async () => {
    signInAs(tenantMember("ADMIN", "t1"));
    exists("t2"); // t2 exists, the user has no role there
    const refused = await setActiveTenantAction("t2");
    exists("nothing-here");
    const missing = await setActiveTenantAction("t3");

    expect(refused).toEqual({ error: "Tenant not found" });
    expect(JSON.stringify(refused)).toBe(JSON.stringify(missing));
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("a member's tenant that has since been deleted is refused like any missing tenant", async () => {
    signInAs(tenantMember("VIEWER", "t1"));
    expect(await setActiveTenantAction("t1")).toEqual({ error: "Tenant not found" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "   ", 5, {}, ["t1"], "a:b"])("refuses the malformed id %j like a missing tenant", async (id) => {
    signInAs(globalAdmin());
    expect(await setActiveTenantAction(id as never)).toEqual({ error: "Tenant not found" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
