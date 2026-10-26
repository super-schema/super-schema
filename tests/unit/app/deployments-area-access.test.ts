// @vitest-environment node
/**
 * The deployment overview (`getDeploymentOverviewAction`) used to list EVERY tenant's entity names, ids, versions and domain names to any
 * session, a user with no role included. It asks the policy first (`tenant.access`: some role in the tenant in view) and lists only the entities
 * of THAT tenant the caller's roles let them read (`deploy.read`, a viewer's act), restricted in the query. The REAL guard runs; the entity service
 * and the database are replaced, so what a refused caller must never reach is observable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";
import { ROLE_HIERARCHY } from "@/types/schemas/rbac";

const T = "tenant-1";
const OTHER = "tenant-2";

const h = vi.hoisted(() => ({
  activeTenant: vi.fn(), getEntities: vi.fn(), getDeploymentOverview: vi.fn(), productFindMany: vi.fn(), domainFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({ prisma: { product: { findMany: h.productFindMany }, domain: { findMany: h.domainFindMany } } }));
vi.mock("@/services/entity.service", () => ({ getEntities: h.getEntities }));
vi.mock("@/services/deployment.service", () => ({ getDeploymentOverview: h.getDeploymentOverview }));

import { getDeploymentOverviewAction } from "@/app/(dashboard)/deployments/actions";

const reached = () => [h.getEntities, h.getDeploymentOverview, h.productFindMany, h.domainFindMany].filter((fn) => fn.mock.calls.length > 0);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signInAs(tenantMember("VIEWER", T));
  h.activeTenant.mockResolvedValue(T);
  h.getEntities.mockResolvedValue({ success: true, data: [{ id: "e1", name: "Order", slug: "order", domainId: "dom-a", productId: "prod-a", version: 1 }] });
  h.domainFindMany.mockResolvedValue([{ id: "dom-a", name: "Payments", slug: "payments" }]);
  h.productFindMany.mockResolvedValue([{ id: "prod-a", slug: "checkout" }]);
  h.getDeploymentOverview.mockImplementation(async (input: Array<{ entityId: string }>) => ({ success: true, data: { rows: input.map((i) => ({ ...i, targets: [] })) } }));
});

describe("getDeploymentOverviewAction", () => {
  it("answers nobody signed in 'Not authenticated' and reaches nothing", async () => {
    signedOut();
    expect(await getDeploymentOverviewAction()).toEqual({ error: "Not authenticated" });
    expect(reached()).toHaveLength(0);
  });

  it("answers a user with no role at all as not found and reaches nothing (they used to read every tenant's entities)", async () => {
    signInAs(roleless());
    expect(await getDeploymentOverviewAction()).toEqual({ error: "Deployments not found" });
    expect(reached()).toHaveLength(0);
  });

  it("is open to every role of the ladder (a viewer's act)", async () => {
    for (const role of ROLE_HIERARCHY) {
      signInAs(tenantMember(role, T));
      expect(await getDeploymentOverviewAction(), role).toMatchObject({ success: true });
    }
  });

  it("a role in another tenant than the one in view lists nothing, even for an administrator", async () => {
    signInAs(tenantMember("ADMIN", OTHER));
    expect(await getDeploymentOverviewAction()).toEqual({ error: "Deployments not found" });
    expect(reached()).toHaveLength(0);
  });

  it("the entities are read in the ACTIVE tenant, for what the caller's roles cover (the service gets the tenant and the assignments)", async () => {
    const assignments = [assign.tenant("VIEWER", T)];
    signInAs(principalOf(assignments, { userId: "u-3" }));
    await getDeploymentOverviewAction();
    expect(h.getEntities).toHaveBeenCalledWith({}, expect.objectContaining({ userId: "u-3", tenantId: T, assignments }));
  });

  it("a platform administrator reads the tenant in view and nothing more", async () => {
    signInAs(principalOf([assign.global()]));
    await getDeploymentOverviewAction();
    expect(h.getEntities).toHaveBeenCalledWith({}, expect.objectContaining({ tenantId: T }));
    expect(h.domainFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["dom-a"] }, tenantId: T } }));
  });

  it("reads only the domains of the listed entities, in the tenant in view", async () => {
    await getDeploymentOverviewAction();
    expect(h.domainFindMany).toHaveBeenCalledWith({ where: { id: { in: ["dom-a"] }, tenantId: T }, select: { id: true, name: true, slug: true } });
  });

  it("with no entity left to list it reads no domain and no product at all", async () => {
    h.getEntities.mockResolvedValue({ success: true, data: [] });
    expect(await getDeploymentOverviewAction()).toMatchObject({ success: true, data: { rows: [] } });
    expect(h.domainFindMany).not.toHaveBeenCalled();
    expect(h.productFindMany).not.toHaveBeenCalled();
  });

  it("a failing database is answered generically, never with its text", async () => {
    h.getEntities.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const answer = await getDeploymentOverviewAction();
    expect(JSON.stringify(answer)).not.toContain("10.0.0.5");
    expect(answer).toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
