import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, roleless, signInAs } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  loadLevelTraits: vi.fn(),
  getActiveTenantId: vi.fn(),
  entityFindMany: vi.fn(),
  fieldGroupBy: vi.fn(),
  empty: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findMany: mocks.entityFindMany },
    field: { groupBy: mocks.fieldGroupBy },
    sharedEnum: { findMany: mocks.empty },
    customScalar: { findMany: mocks.empty },
    unionType: { findMany: mocks.empty },
  },
}));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.getActiveTenantId, requireActiveTenantId: mocks.getActiveTenantId, NO_ACCESS_PATH: "/no-access" }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/features/events/workspace/load-events-tab-data", () => ({
  loadLevelTraits: mocks.loadLevelTraits,
}));
vi.mock("@/app/(dashboard)/schemas/enterprise/enterprise-workspace", () => ({
  EnterpriseWorkspace: () => null,
}));

import EnterprisePage from "@/app/(dashboard)/schemas/enterprise/page";

beforeEach(() => {
  vi.clearAllMocks();
  signInAs(globalAdmin());
  mocks.getActiveTenantId.mockResolvedValue("tenant-1");
  mocks.loadLevelTraits.mockResolvedValue({ own: [], inherited: [] });
  mocks.empty.mockResolvedValue([]);
  mocks.entityFindMany.mockResolvedValue([
    {
      id: "e1",
      name: "Customer",
      slug: "customer",
      description: "",
      status: "ACTIVE",
      version: 1,
      updatedAt: new Date("2026-10-01T00:00:00Z"),
      _count: { fields: 3 },
    },
    {
      id: "e2",
      name: "Empty",
      slug: "empty",
      description: "",
      status: "DRAFT",
      version: 1,
      updatedAt: new Date("2026-10-01T00:00:00Z"),
      _count: { fields: 0 },
    },
  ]);
  mocks.fieldGroupBy.mockResolvedValue([
    { entityId: "e1", classification: "PII", _count: 2 },
    { entityId: "e1", classification: "INTERNAL", _count: 1 },
  ]);
});

describe("EnterprisePage", () => {
  it("tallies classifications for tenant-level entities from one field.groupBy", async () => {
    const element = await EnterprisePage();

    expect(mocks.fieldGroupBy).toHaveBeenCalledWith({
      by: ["entityId", "classification"],
      where: { entity: { tenantId: "tenant-1", domainId: null, productId: null } },
      _count: true,
    });
    expect(mocks.entityFindMany.mock.calls[0][0].include).toEqual({
      _count: { select: { fields: true } },
    });
    const [customer, empty] = element.props.entities;
    expect(customer.classifications).toEqual({ NEVER_STORED: 0, PII: 2, SENSITIVE: 0, INTERNAL: 1, PUBLIC: 0 });
    expect(customer.fieldCount).toBe(3);
    expect(empty.classifications).toEqual({ NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 });
  });

  it("loads the Enterprise-level traits for the active tenant and passes them on", async () => {
    const traits = {
      own: [{ id: "t1", name: "CloudEvents", kind: "MESSAGE", summary: "", updatedAt: "", href: "/schemas/enterprise/traits/t1" }],
      inherited: [],
    };
    mocks.loadLevelTraits.mockResolvedValue(traits);

    const element = await EnterprisePage();

    expect(mocks.loadLevelTraits).toHaveBeenCalledWith({
      scope: { tenantId: "tenant-1", domainId: null, productId: null },
      domainSlug: null,
    });
    expect(element.props.traits).toBe(traits);
  });
});

// The Enterprise level is the tenant itself: a role over the whole tenant (or the platform) reads it; a role at one domain or product does not, and neither does a
// user with no role. They get a 404 and nothing is read.
describe("EnterprisePage: who may see the tenant-level assets", () => {
  it.each([
    ["a viewer of the tenant", [assign.tenant("VIEWER", "tenant-1")]],
    ["an author of the tenant", [assign.tenant("AUTHOR", "tenant-1")]],
    ["a platform administrator", [assign.global()]],
  ])("%s sees them", async (_who, assignments) => {
    signInAs(principalOf(assignments));
    expect((await EnterprisePage()).props.entities).toHaveLength(2);
  });

  it.each([
    ["an author of one domain", [assign.domain("AUTHOR", "tenant-1", "dom-1")]],
    ["an administrator of one product", [assign.product("ADMIN", "tenant-1", "dom-1", "prod-1")]],
    ["an administrator of ANOTHER tenant", [assign.tenant("ADMIN", "tenant-2")]],
    ["a user with no role", []],
  ])("%s gets a 404 and nothing is read", async (_who, assignments) => {
    signInAs(principalOf(assignments));
    await expect(EnterprisePage()).rejects.toThrow("not found");
    expect(mocks.entityFindMany).not.toHaveBeenCalled();
    expect(mocks.loadLevelTraits).not.toHaveBeenCalled();
  });

  it("nobody (a disabled user, a stale session) is sent to /no-access", async () => {
    signInAs(null);
    await expect(EnterprisePage()).rejects.toThrow("NEXT_REDIRECT /no-access");
    expect(roleless().assignments).toEqual([]);
    expect(mocks.entityFindMany).not.toHaveBeenCalled();
  });
});
