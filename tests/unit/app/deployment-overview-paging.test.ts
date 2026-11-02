// @vitest-environment node
/**
 * The deployment overview is paged: `getDeploymentOverviewAction` returns one page (25 rows by default, at most 100) and the total, so every
 * entity of the tenant can be reached, and the filters narrow the rows the paging counts. The deployment SERVICE is the real one, over a fake
 * database, so the 25-row cap that used to hide the other entities is what this test would see (the entity list and the auth are replaced).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";

const h = vi.hoisted(() => ({
  activeTenant: vi.fn(),
  getEntities: vi.fn(),
  deploymentFindMany: vi.fn(),
  domainFindMany: vi.fn(),
  productFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({
  prisma: {
    deploymentRecord: { findMany: h.deploymentFindMany },
    domain: { findMany: h.domainFindMany },
    product: { findMany: h.productFindMany },
  },
}));
vi.mock("@/services/entity.service", () => ({ getEntities: h.getEntities }));

import { getDeploymentOverviewAction } from "@/app/(dashboard)/deployments/actions";

const ENTITY_COUNT = 30;
const enabledTargets = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab);
const [firstTarget] = enabledTargets;

/** Thirty entities, alternately in two domains, in the order the entity list returns them (most recently updated first). */
function entities() {
  return Array.from({ length: ENTITY_COUNT }, (_, i) => ({
    id: `e${i}`,
    name: `Entity ${i}`,
    slug: `entity-${i}`,
    domainId: i % 2 === 0 ? "dom-a" : "dom-b",
    productId: null,
    version: 1,
  }));
}

/** The page of an answer that is a page; any other answer fails the test with what it said. */
function pageOf(res: Awaited<ReturnType<typeof getDeploymentOverviewAction>>) {
  if (!("data" in res) || res.data === undefined) throw new Error(`expected a page, got ${JSON.stringify(res)}`);
  return res.data;
}

/** A deployment record of one emission target (`<entityId>:<target>`), as the database returns it. */
const record = (target: string, isDrifted: boolean) => ({
  id: `rec-${target}`,
  entityId: target,
  target,
  environment: "production",
  version: 1,
  status: "DEPLOYED",
  driftReport: null,
  isDrifted,
  deployedBy: "user-1",
  deployedAt: new Date("2026-10-01T10:00:00Z"),
  updatedAt: new Date("2026-10-01T10:00:00Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.activeTenant.mockResolvedValue("tenant-1");
  h.getEntities.mockResolvedValue({ success: true, data: entities() });
  h.domainFindMany.mockResolvedValue([
    { id: "dom-a", name: "Payments", slug: "payments" },
    { id: "dom-b", name: "Shipping", slug: "shipping" },
  ]);
  h.productFindMany.mockResolvedValue([]);
  h.deploymentFindMany.mockResolvedValue([]);
});

describe("getDeploymentOverviewAction paging", () => {
  it("returns one page of 25 rows and the total; the pages together reach every entity", async () => {
    const first = pageOf(await getDeploymentOverviewAction());
    const second = pageOf(await getDeploymentOverviewAction({ offset: 25, limit: 25 }));

    expect(first.total).toBe(ENTITY_COUNT);
    expect(second.total).toBe(ENTITY_COUNT);
    expect(first.rows).toHaveLength(25);
    expect(second.rows).toHaveLength(5);
    const reached = new Set([...first.rows, ...second.rows].map((row) => row.entityId));
    expect(reached.size).toBe(ENTITY_COUNT);
  });

  it("the domain filter narrows the rows and the total, and the action lists the domains of the tenant", async () => {
    const res = pageOf(await getDeploymentOverviewAction({ filters: { domain: "Payments" } }));

    expect(res.total).toBe(15);
    expect(res.domains).toEqual(["Payments", "Shipping"]);
    expect(res.rows.every((row) => row.domain === "Payments")).toBe(true);
  });

  it("a drift filter with a target reads that target's drift, not the drift of another target", async () => {
    const other = enabledTargets[1];
    // Entity 4 is drifted in the first target; entity 6 is drifted only in the second.
    h.deploymentFindMany.mockResolvedValue([record(`e4:${firstTarget.key}`, true), record(`e6:${other.key}`, true)]);

    const res = pageOf(await getDeploymentOverviewAction({ filters: { driftStatus: "drifted", targetFormat: firstTarget.targetFormat } }));

    expect(res.total).toBe(1);
    expect(res.rows.map((row) => row.entityId)).toEqual(["e4"]);
  });

  it("a page size above 100, or a negative offset, is refused before anything is read", async () => {
    expect(await getDeploymentOverviewAction({ limit: 500 })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await getDeploymentOverviewAction({ offset: -1 })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.getEntities).not.toHaveBeenCalled();
    expect(h.deploymentFindMany).not.toHaveBeenCalled();
  });
});
