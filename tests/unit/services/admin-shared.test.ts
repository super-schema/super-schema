// @vitest-environment node
/**
 * What the administration services share: who administers what, who reaches whom, how a failure of the database becomes an answer.
 */
import { describe, expect, it, vi } from "vitest";
import { assign } from "../../helpers/access-mocks";

// `admin-shared` reaches the database only through `runSerializable`'s error test: the app's client is a stand-in here.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { administeredBy, administersSomething, administersTenant, answering, commonTenantId, reaches } from "@/services/admin-shared";

describe("administeredBy: what an administrator administers", () => {
  it("a platform administrator administers everything", () => {
    const administered = administeredBy([assign.global()]);
    expect(administered.platform).toBe(true);
    expect(administersSomething(administered)).toBe(true);
    expect(administersTenant(administered, "any-tenant")).toBe(true);
  });

  it("a tenant administrator administers the tenants where they hold ADMIN at tenant scope, and only those", () => {
    const administered = administeredBy([assign.tenant("ADMIN", "t1"), assign.tenant("ADMIN", "t2"), assign.tenant("STEWARD", "t3")]);
    expect(administered.platform).toBe(false);
    expect([...administered.tenantIds].sort()).toEqual(["t1", "t2"]);
    expect(administersTenant(administered, "t1")).toBe(true);
    expect(administersTenant(administered, "t3")).toBe(false);
    expect(administersTenant(administered, null)).toBe(false);
    expect(administersTenant(administered, undefined)).toBe(false);
  });

  it("a domain or product administrator administers no tenant (user management is the tenant administrator's act)", () => {
    const administered = administeredBy([assign.domain("ADMIN", "t1", "d1"), assign.product("ADMIN", "t1", "d1", "p1")]);
    expect(administersSomething(administered)).toBe(false);
  });

  it("every role below ADMIN, and no role at all, administers nothing", () => {
    for (const role of ["VIEWER", "AUTHOR", "STEWARD", "COMPLIANCE_OFFICER"] as const) expect(administersSomething(administeredBy([assign.tenant(role, "t1")])), role).toBe(false);
    expect(administersSomething(administeredBy([]))).toBe(false);
  });

  it("an assignment that is not valid (a platform role other than ADMIN) is nothing", () => {
    expect(administersSomething(administeredBy([{ role: "STEWARD", scope: { kind: "GLOBAL" } } as never]))).toBe(false);
  });
});

describe("reaches: may the actor administer a user who holds these roles", () => {
  const tenantAdmin = administeredBy([assign.tenant("ADMIN", "t1")]);
  const platform = administeredBy([assign.global()]);
  const row = (scopeKey: string, tenantId: string | null) => ({ scopeKey, tenantId });

  it("a platform administrator reaches every user, a roleless one included", () => {
    expect(reaches(platform, [])).toBe(true);
    expect(reaches(platform, [row("G", null)])).toBe(true);
    expect(reaches(platform, [row("T:t9", "t9")])).toBe(true);
  });

  it("a tenant administrator reaches a user whose every role lies in a tenant they administer (tenant, domain and product scopes alike)", () => {
    expect(reaches(tenantAdmin, [row("T:t1", "t1")])).toBe(true);
    expect(reaches(tenantAdmin, [row("T:t1", "t1"), row("D:d1", "t1"), row("P:p1", "t1")])).toBe(true);
  });

  it("not a user with a role in another tenant too, not a user with a platform role, not a user with no role", () => {
    expect(reaches(tenantAdmin, [row("T:t1", "t1"), row("T:t2", "t2")])).toBe(false);
    expect(reaches(tenantAdmin, [row("T:t1", "t1"), row("G", null)])).toBe(false);
    expect(reaches(tenantAdmin, [row("G", null)])).toBe(false);
    expect(reaches(tenantAdmin, [row("T:t2", "t2")])).toBe(false);
    expect(reaches(tenantAdmin, [])).toBe(false);
  });

  it("a row whose tenant column is missing is out of reach (a row that says nothing about its tenant is nobody's to administer)", () => {
    expect(reaches(tenantAdmin, [{ scopeKey: "D:d1" }])).toBe(false);
    expect(reaches(tenantAdmin, [{ scopeKey: "D:d1", tenantId: null }])).toBe(false);
  });
});

describe("commonTenantId", () => {
  it("is the one tenant every entry names, and none for a spread, a platform entry, or nothing", () => {
    expect(commonTenantId(["t1", "t1"])).toBe("t1");
    expect(commonTenantId(["t1", "t2"])).toBeNull();
    expect(commonTenantId(["t1", null])).toBeNull();
    expect(commonTenantId([null])).toBeNull();
    expect(commonTenantId([])).toBeNull();
    expect(commonTenantId([undefined, "t1"])).toBeNull();
  });
});

describe("answering: a failure of the database is an answer, never an exception", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("passes a result through", async () => {
    expect(await answering("x", async () => ({ success: true as const, data: 1 }))).toEqual({ success: true, data: 1 });
  });

  it("maps a unique-key loss to DUPLICATE, a vanished row to NOT_FOUND, a lost race to CONFLICT, and anything else to INTERNAL_ERROR (logged)", async () => {
    const log = quiet();
    const failing = (error: unknown) => answering("x", async () => { throw error; });
    expect(await failing(Object.assign(new Error("u"), { code: "P2002" }))).toMatchObject({ success: false, error: { code: "DUPLICATE" } });
    expect(await failing(Object.assign(new Error("f"), { code: "P2003" }))).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(await failing(Object.assign(new Error("m"), { code: "P2025" }))).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(await failing(Object.assign(new Error("w"), { code: "P2034" }))).toMatchObject({ success: false, error: { code: "CONFLICT" } });
    expect(await failing(new Error("boom"))).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
    expect(await failing("a string")).toMatchObject({ success: false, error: { code: "INTERNAL_ERROR" } });
    expect(await failing(null)).toMatchObject({ success: false, error: { code: "INTERNAL_ERROR" } });
    expect(log).toHaveBeenCalled();
  });

  it("an answer never carries the database's own text", async () => {
    quiet();
    const result = await answering("x", async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "user_roles_userId_role_scopeKey_key"'), { code: "P2002" });
    });
    expect(JSON.stringify(result)).not.toMatch(/violates|constraint|user_roles/);
  });
});
