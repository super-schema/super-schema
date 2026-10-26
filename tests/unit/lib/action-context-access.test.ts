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

  it("runs for a user with the role, with a service context whose userRole is the role they hold OVER THAT RESOURCE, and revalidates", async () => {
    signInAs(principalOf([assign.tenant("VIEWER", T1), assign.domain("STEWARD", T1, "dom-a")], { userId: "u-9" }));
    expect(await runMutation(ACCESS, run, "writeEntity")).toEqual({ success: true, data: "done" });
    expect(run).toHaveBeenCalledWith({ userId: "u-9", userRole: "STEWARD", prisma: mocks.prisma });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");
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

  it("leaves a malformed target to the service, which answers its own validation error (as the adapter always did)", async () => {
    signInAs(roleless());
    expect(await withOwnedTarget("event.write", { level: "DOMAIN", domainId: 5 }, run)).toEqual({ success: true, data: "ran" });
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
