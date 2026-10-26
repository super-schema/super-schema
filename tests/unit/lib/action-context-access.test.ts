// @vitest-environment node
/**
 * The guarded wrappers of src/lib/action-context.ts: `runMutation({ action, resource }, run)` and `withOwnedTarget(action, target, run)` ask
 * `authorize` before the service runs; the old call shapes keep working as thin adapters (tests/unit/lib/action-context.test.ts and
 * by-id-guards.test.ts pin those). A user who may not see a resource gets the very answer a missing resource gets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, roleless, signInAs, signedOut, tenantMember, T1, T2 } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  activeTenant: vi.fn(),
  prisma: {
    tag: "prisma",
    entity: { findUnique: vi.fn() },
    domain: { findUnique: vi.fn() },
    product: { findUnique: vi.fn() },
    tenant: { findUnique: vi.fn() },
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.activeTenant }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);

import { NoTenantAccess } from "@/lib/access/no-tenant-access";
import {
  GENERIC_ACTION_ERROR,
  NOT_AUTHENTICATED,
  authorizeActiveTenant,
  authorizeInActiveTenant,
  authorizeSubject,
  contextOf,
  inActiveTenant,
  isInActiveTenant,
  notFoundError,
  runMutation,
  targetInActiveTenant,
  unexpectedFailure,
  withOwnedTarget,
} from "@/lib/action-context";
import { resolveScope } from "@/lib/asset-scope";

const ok = <T,>(data: T) => ({ success: true as const, data });
const NOT_FOUND_ACTION = { success: false, error: "Not found", code: "NOT_FOUND" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeTenant.mockResolvedValue(T1);
  signInAs(globalAdmin());
});

describe("runMutation with an access spec", () => {
  const run = vi.fn(async () => ok("done"));
  beforeEach(() => run.mockClear());
  const ACCESS = { action: "entity.write", resource: { tenantId: T1, domainId: "dom-a", productId: null } } as const;

  it("answers NOT_AUTHENTICATED to nobody, without running or revalidating", async () => {
    signedOut();
    expect(await runMutation(ACCESS, run)).toEqual(NOT_AUTHENTICATED);
    expect(run).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND to a user with no role, and never runs", async () => {
    signInAs(roleless());
    expect(await runMutation(ACCESS, run)).toEqual(NOT_FOUND_ACTION);
    expect(run).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers a generic FORBIDDEN to a user who may see the resource but holds too low a role", async () => {
    signInAs(tenantMember("VIEWER", T1));
    const answer = await runMutation(ACCESS, run);
    expect(answer).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(JSON.stringify(answer)).not.toMatch(/VIEWER|AUTHOR|entity|dom-a|tenant-1/);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs for a user with the role, with a service context that carries the assignments and NO resource-relative role label, and revalidates", async () => {
    const principal = principalOf([assign.tenant("VIEWER", T1), assign.domain("STEWARD", T1, "dom-a")], { userId: "u-9" });
    signInAs(principal);
    expect(await runMutation(ACCESS, run, "writeEntity")).toEqual({ success: true, data: "done" });
    // The label is the platform role only (here none: the lowest rung): a domain STEWARD must NOT look like a STEWARD to a service that compares it.
    expect(run).toHaveBeenCalledWith({ userId: "u-9", userRole: "VIEWER", assignments: principal.assignments, prisma: mocks.prisma });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");
  });

  it("refuses a resource of another tenant than the ACTIVE one as a missing resource, even for a user who holds a covering role there", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T1), assign.tenant("ADMIN", T2)]));
    mocks.activeTenant.mockResolvedValue(T1);
    const inB = { action: "entity.write", resource: { tenantId: T2, domainId: null, productId: null } } as const;
    expect(await runMutation(inB, run)).toEqual(NOT_FOUND_ACTION);
    expect(run).not.toHaveBeenCalled();
    mocks.activeTenant.mockResolvedValue(T2);
    expect(await runMutation(inB, run)).toEqual({ success: true, data: "done" });
  });

  it("refuses even a global administrator outside the active tenant (the tenant in view is part of the decision)", async () => {
    signInAs(globalAdmin());
    mocks.activeTenant.mockResolvedValue(T2);
    expect(await runMutation(ACCESS, run)).toEqual(NOT_FOUND_ACTION);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an AUTHOR of a sibling domain as a missing resource (domain roles take effect)", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T1, "dom-b")]));
    expect(await runMutation(ACCESS, run)).toEqual(NOT_FOUND_ACTION);
    expect(run).not.toHaveBeenCalled();
  });

  it("resolves a stored row by kind and id: a row of another tenant and a missing row answer identically", async () => {
    signInAs(tenantMember("ADMIN", T1));
    const byId = { action: "entity.write", resource: { kind: "entity", id: "e1" } } as const;
    mocks.prisma.entity.findUnique.mockResolvedValueOnce({ tenantId: T2, domainId: null, productId: null, product: null });
    const foreign = await runMutation(byId, run);
    mocks.prisma.entity.findUnique.mockResolvedValueOnce(null);
    const missing = await runMutation(byId, run);
    expect(foreign).toEqual(NOT_FOUND_ACTION);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(run).not.toHaveBeenCalled();

    mocks.prisma.entity.findUnique.mockResolvedValueOnce({ tenantId: T1, domainId: null, productId: null, product: null });
    expect(await runMutation(byId, run)).toEqual({ success: true, data: "done" });
  });

  it("uses the caller's own not-found answer for both the missing row and the one the user cannot see", async () => {
    signInAs(tenantMember("ADMIN", T1));
    const access = { ...ACCESS, resource: { kind: "entity", id: "e1" }, notFound: { code: "NOT_FOUND", message: "Entity not found" } } as const;
    mocks.prisma.entity.findUnique.mockResolvedValueOnce({ tenantId: T2, domainId: null, productId: null, product: null });
    const foreign = await runMutation(access, run);
    mocks.prisma.entity.findUnique.mockResolvedValueOnce(null);
    expect(await runMutation(access, run)).toEqual(foreign);
    expect(foreign).toEqual({ success: false, error: "Entity not found", code: "NOT_FOUND" });
  });

  it("a failing service result is carried and not revalidated; an unexpected throw is generic; NoTenantAccess is a not-found answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runMutation(ACCESS, async () => ({ success: false as const, error: { code: "CONFLICT", message: "taken" } }))).toEqual({
      success: false, error: "taken", code: "CONFLICT",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(await runMutation(ACCESS, async () => { throw new Error("boom"); })).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(await runMutation(ACCESS, async () => { throw new NoTenantAccess(); })).toEqual(NOT_FOUND_ACTION);
  });

  it("keeps the old call shape working: runMutation(run, label) is the adapter, authenticated by the same session", async () => {
    signedOut();
    // The adapter's session is Auth.js + resolveCurrentUserId (see action-context.test.ts); with no session it is not authenticated.
    expect(await runMutation(run, "legacy")).toEqual(NOT_AUTHENTICATED);
  });
});

describe("withOwnedTarget with an action", () => {
  const run = vi.fn(async () => ok("ran"));
  const domainTarget = { level: "DOMAIN", domainId: "dom-a" };
  const missingMessage = 'Domain "dom-a" not found';
  beforeEach(() => {
    run.mockClear();
    mocks.prisma.domain.findUnique.mockResolvedValue({ id: "dom-a", tenantId: T1 });
  });

  it("runs for a target in the active tenant that the user may act on", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T1, "dom-a")]));
    expect(await withOwnedTarget("event.write", domainTarget, run)).toEqual({ success: true, data: "ran" });
  });

  it("answers a target that exists but the user cannot see with EXACTLY the answer for a missing target (resolveScope's message)", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T1, "dom-b")]));
    const unseen = await withOwnedTarget("event.write", domainTarget, run);
    mocks.prisma.domain.findUnique.mockResolvedValue(null);
    const missing = await withOwnedTarget("event.write", domainTarget, run);
    expect(unseen).toEqual({ success: false, error: { code: "NOT_FOUND", message: missingMessage } });
    expect(JSON.stringify(unseen)).toBe(JSON.stringify(missing));
    expect(run).not.toHaveBeenCalled();
  });

  it("answers a user with no role the same way, and a target of another tenant too", async () => {
    signInAs(roleless());
    expect(await withOwnedTarget("event.write", domainTarget, run)).toEqual({ success: false, error: { code: "NOT_FOUND", message: missingMessage } });
    signInAs(tenantMember("ADMIN", T1));
    mocks.prisma.domain.findUnique.mockResolvedValue({ id: "dom-a", tenantId: T2 });
    expect(await withOwnedTarget("event.write", domainTarget, run)).toEqual({ success: false, error: { code: "NOT_FOUND", message: missingMessage } });
    expect(run).not.toHaveBeenCalled();
  });

  it("answers a generic FORBIDDEN to a user who sees the target and holds too low a role", async () => {
    signInAs(tenantMember("VIEWER", T1));
    const answer = await withOwnedTarget("event.write", domainTarget, run);
    expect(answer).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("judges a product target against its product, domain and tenant", async () => {
    mocks.prisma.product.findUnique.mockResolvedValue({ id: "p1", domainId: "dom-a", domain: { tenantId: T1 } });
    signInAs(principalOf([assign.product("AUTHOR", T1, "dom-a", "p1")]));
    expect(await withOwnedTarget("event.write", { level: "PRODUCT", productId: "p1" }, run)).toMatchObject({ success: true });
    signInAs(principalOf([assign.product("AUTHOR", T1, "dom-a", "p2")]));
    expect(await withOwnedTarget("event.write", { level: "PRODUCT", productId: "p1" }, run)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("FAILS CLOSED on a malformed target: the NOT_FOUND whole error, no lookup, and the service never runs (not even for a role-less or an administrator principal)", async () => {
    const reference = JSON.stringify(await withOwnedTarget("event.write", null, run));
    for (const principal of [roleless(), globalAdmin(), tenantMember("ADMIN", T1)]) {
      signInAs(principal);
      for (const target of [{ level: "DOMAIN", domainId: 5 }, { level: "NOPE" }, { level: "DOMAIN" }, null, undefined, "dom-a", 7, [], {}]) {
        const answer = await withOwnedTarget("event.write", target, run);
        expect(answer).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
        expect(JSON.stringify(answer)).toBe(reference);
      }
    }
    expect(run).not.toHaveBeenCalled();
    expect(mocks.prisma.domain.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a target of another tenant than the active one even when the user holds a role there", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T1), assign.tenant("ADMIN", T2)]));
    mocks.prisma.domain.findUnique.mockResolvedValue({ id: "dom-a", tenantId: T2 });
    mocks.activeTenant.mockResolvedValue(T1);
    expect(await withOwnedTarget("event.write", domainTarget, run)).toEqual({ success: false, error: { code: "NOT_FOUND", message: missingMessage } });
    expect(run).not.toHaveBeenCalled();
  });

  it("answers nobody signed in before it looks the target up", async () => {
    signedOut();
    expect(await withOwnedTarget("event.write", domainTarget, run)).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect(mocks.prisma.domain.findUnique).not.toHaveBeenCalled();
  });

  it("keeps the old call shape: withOwnedTarget(target, run) is the active-tenant adapter and asks no role", async () => {
    signInAs(roleless()); // the adapter predates roles: it checks the active tenant only (Task 5 moves each caller to an action)
    expect(await withOwnedTarget(domainTarget, run)).toEqual({ success: true, data: "ran" });
    mocks.activeTenant.mockResolvedValue(T2);
    expect(await withOwnedTarget(domainTarget, run)).toEqual({ success: false, error: { code: "NOT_FOUND", message: missingMessage } });
  });
});

describe("the adapters of the active-tenant guards", () => {
  it("a user with no tenant access is OUTSIDE every tenant: false / NOT_FOUND, the same as for a missing row, never an error", async () => {
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    expect(await isInActiveTenant(T1)).toBe(false);

    mocks.prisma.entity.findUnique.mockResolvedValue({ tenantId: T1 });
    expect(await inActiveTenant("entity", "e1")).toBe(false);

    mocks.prisma.domain.findUnique.mockResolvedValue({ id: "d1", tenantId: T1 });
    const noAccess = await targetInActiveTenant({ level: "DOMAIN", domainId: "d1" });
    mocks.prisma.domain.findUnique.mockResolvedValue(null);
    const missing = await targetInActiveTenant({ level: "DOMAIN", domainId: "d1" });
    expect(noAccess).toEqual(missing);
    expect(noAccess).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(await resolveScope(mocks.prisma as never, { level: "DOMAIN", domainId: "d1" })).toEqual(missing);
  });

  it("does not hide any other failure of the tenant lookup", async () => {
    mocks.activeTenant.mockRejectedValue(new Error("connection lost"));
    await expect(isInActiveTenant(T1)).rejects.toThrow("connection lost");
  });

  it("unexpectedFailure answers NoTenantAccess as a not-found, like every other refusal to see", () => {
    expect(unexpectedFailure("someAction", new NoTenantAccess())).toEqual({ error: "Not found", code: "NOT_FOUND" });
    expect(notFoundError()).toEqual({ code: "NOT_FOUND", message: "Not found" });
  });
});

describe("authorizeInActiveTenant: the one helper behind runMutation, withOwnedTarget and authorizeSubject", () => {
  const inA = { tenantId: T1, domainId: "dom-a", productId: null };

  it("needs BOTH: the resource in the active tenant AND a covering role", async () => {
    signInAs(tenantMember("AUTHOR", T1, "u-1"));
    expect(await authorizeInActiveTenant("entity.write", inA)).toMatchObject({ success: true, data: { userId: "u-1" } });
    expect(await authorizeInActiveTenant("entity.publish", inA)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });

    mocks.activeTenant.mockResolvedValue(T2);
    signInAs(principalOf([assign.tenant("ADMIN", T1), assign.tenant("ADMIN", T2)]));
    expect(await authorizeInActiveTenant("entity.write", inA)).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
  });

  it("answers nobody with UNAUTHORIZED, and a role-less user, a wrong tenant and a sibling with the one NOT_FOUND whole error", async () => {
    signedOut();
    expect(await authorizeInActiveTenant("entity.read", inA)).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    signInAs(roleless());
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    const roleLess = await authorizeInActiveTenant("entity.read", inA);
    signInAs(tenantMember("VIEWER", T1));
    mocks.activeTenant.mockResolvedValue(T2);
    const wrongTenant = await authorizeInActiveTenant("entity.read", inA);
    mocks.activeTenant.mockResolvedValue(T1);
    const sibling = await authorizeInActiveTenant("entity.read", { tenantId: T2 });
    expect(roleLess).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
    expect(JSON.stringify(wrongTenant)).toBe(JSON.stringify(roleLess));
    expect(JSON.stringify(sibling)).toBe(JSON.stringify(roleLess));
  });

  it("does not tie platform (global) and own (self) actions to a tenant: they have no resource to hide", async () => {
    signInAs(globalAdmin());
    mocks.activeTenant.mockResolvedValue(T2);
    expect(await authorizeInActiveTenant("platform.admin", inA)).toMatchObject({ success: true });
    signInAs(roleless());
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    expect(await authorizeInActiveTenant("notification.own", inA)).toMatchObject({ success: true });
    expect(await authorizeInActiveTenant("platform.admin", inA)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
  });

  it("answers an unknown action id FORBIDDEN, even to a global administrator", async () => {
    signInAs(globalAdmin());
    expect(await authorizeInActiveTenant("nope.nope" as never, inA)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
  });

  it("uses the caller's own not-found answer", async () => {
    signInAs(roleless());
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    const own = { code: "NOT_FOUND", message: "Entity not found" } as const;
    expect(await authorizeInActiveTenant("entity.read", inA, own)).toEqual({ success: false, error: own });
  });

  it("authorizeActiveTenant judges a tenant-wide action against the ACTIVE tenant itself", async () => {
    signInAs(tenantMember("STEWARD", T1));
    expect(await authorizeActiveTenant("domain.create")).toMatchObject({ success: true });
    expect(await authorizeActiveTenant("domain.delete")).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    mocks.activeTenant.mockResolvedValue(T2);
    expect(await authorizeActiveTenant("domain.create")).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    expect(await authorizeActiveTenant("domain.create")).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("authorizeSubject applies the active tenant and does the same look-ups for a foreign row and a missing one", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T1), assign.tenant("ADMIN", T2)]));
    mocks.activeTenant.mockResolvedValue(T1);
    mocks.activeTenant.mockClear();
    mocks.prisma.entity.findUnique.mockClear();
    mocks.prisma.entity.findUnique.mockResolvedValueOnce({ tenantId: T2, domainId: null, productId: null, product: null });
    const foreign = await authorizeSubject("entity.read", { kind: "entity", id: "e1" });
    const foreignReads = [mocks.activeTenant.mock.calls.length, mocks.prisma.entity.findUnique.mock.calls.length];
    mocks.activeTenant.mockClear();
    mocks.prisma.entity.findUnique.mockClear();
    mocks.prisma.entity.findUnique.mockResolvedValueOnce(null);
    const missing = await authorizeSubject("entity.read", { kind: "entity", id: "e1" });
    expect([mocks.activeTenant.mock.calls.length, mocks.prisma.entity.findUnique.mock.calls.length]).toEqual(foreignReads);
    expect(foreign).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
  });
});

describe("contextOf: the resource-relative role label is retired", () => {
  it("carries the platform role only (never a role over a resource) and the assignments the policy judged", () => {
    const principal = principalOf([assign.tenant("ADMIN", T1), assign.domain("STEWARD", T1, "dom-a")], { userId: "u-1" });
    expect(contextOf(principal)).toEqual({ userId: "u-1", userRole: "VIEWER", assignments: principal.assignments, prisma: mocks.prisma });
    expect(contextOf(globalAdmin("a-1"))).toMatchObject({ userId: "a-1", userRole: "ADMIN" });
  });
});
