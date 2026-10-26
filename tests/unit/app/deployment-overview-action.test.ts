/**
 * getDeploymentOverviewAction enriches overview rows with the route slugs the
 * table feeds to assetHref: real slugs for placed entities, null for tenant-level.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  activeTenant: vi.fn(),
  getEntities: vi.fn(),
  getDeploymentOverview: vi.fn(),
  productFindMany: vi.fn(),
  domainFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.activeTenant }));
vi.mock("@/lib/db", () => ({ prisma: { product: { findMany: mocks.productFindMany }, domain: { findMany: mocks.domainFindMany } } }));
vi.mock("@/services/entity.service", () => ({ getEntities: mocks.getEntities }));
vi.mock("@/services/deployment.service", () => ({ getDeploymentOverview: mocks.getDeploymentOverview }));

import { resetSessionPrincipal } from "../../helpers/access-mocks";
import { getDeploymentOverviewAction } from "@/app/(dashboard)/deployments/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
  resetSessionPrincipal();
  mocks.activeTenant.mockResolvedValue("tenant-1");
  mocks.domainFindMany.mockResolvedValue([{ id: "dom-1", name: "Payments", slug: "payments" }]);
  mocks.getEntities.mockResolvedValue({
    success: true,
    data: [
      { id: "e1", name: "Order", slug: "order", domainId: "dom-1", productId: "prod-1", version: 1 },
      { id: "e0", name: "Customer", slug: "customer", domainId: null, productId: null, version: 2 },
    ],
  });
  mocks.productFindMany.mockResolvedValue([{ id: "prod-1", slug: "checkout" }]);
  mocks.getDeploymentOverview.mockImplementation(async (input: Array<{ entityId: string; entityName: string; domain: string; currentVersion: string | null }>) => ({
    success: true,
    data: { rows: input.map((i) => ({ ...i, targets: [] })) },
  }));
});

describe("getDeploymentOverviewAction", () => {
  it("carries route slugs: real for a product entity, null for a tenant-level entity", async () => {
    const res = await getDeploymentOverviewAction();

    expect(res).toMatchObject({ success: true });
    const rows = ("data" in res && res.data?.rows) || [];
    expect(rows.find((r) => r.entityId === "e1")).toMatchObject({
      entitySlug: "order",
      domainSlug: "payments",
      productSlug: "checkout",
    });
    expect(rows.find((r) => r.entityId === "e0")).toMatchObject({
      entitySlug: "customer",
      domainSlug: null,
      productSlug: null,
    });
    expect(mocks.productFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["prod-1"] } },
      select: { id: true, slug: true },
    });
  });

  it("skips the product lookup when every entity is tenant-level", async () => {
    mocks.getEntities.mockResolvedValue({
      success: true,
      data: [{ id: "e0", name: "Customer", slug: "customer", domainId: null, productId: null, version: 2 }],
    });

    await getDeploymentOverviewAction();

    expect(mocks.productFindMany).not.toHaveBeenCalled();
  });
});
