// @vitest-environment node
/**
 * Defence in depth behind the middleware (tests/unit/middleware.test.ts): the app's own JSON endpoints that serve tenant data check the
 * session THEMSELVES, so a request that reaches the handler without going through the middleware (a changed matcher, a path the
 * matcher does not see, a future refactor) still gets a 401 and no query is made.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: {
    tenant: { findMany: vi.fn() },
    domain: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
    entity: { findMany: vi.fn() },
    sharedEnum: { findMany: vi.fn() },
    customScalar: { findMany: vi.fn() },
    unionType: { findMany: vi.fn() },
    serviceDefinition: { findMany: vi.fn() },
    trait: { groupBy: vi.fn() },
    eventSpec: { groupBy: vi.fn() },
  },
  activeTenantId: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.activeTenantId }));

import { GET as getDomainsTree } from "@/app/api/domains-tree/route";
import { GET as getTenants } from "@/app/api/tenants/route";
import { requireSession } from "@/lib/require-session";

const SESSION = { user: { id: "user-1", email: "a@b.c" }, expires: "2999-01-01" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeTenantId.mockResolvedValue("tenant-1");
  mocks.prisma.tenant.findMany.mockResolvedValue([
    { id: "tenant-1", name: "Default", slug: "default", description: "", isSystem: true, _count: { domains: 2 } },
  ]);
  mocks.prisma.domain.findMany.mockResolvedValue([{ id: "d1", name: "Billing", slug: "billing", isSystem: false }]);
  for (const model of ["product", "entity", "sharedEnum", "customScalar", "unionType", "serviceDefinition"] as const) {
    mocks.prisma[model].findMany.mockResolvedValue([]);
  }
  mocks.prisma.trait.groupBy.mockResolvedValue([]);
  mocks.prisma.eventSpec.groupBy.mockResolvedValue([]);
});

const queriesMade = () =>
  Object.values(mocks.prisma).reduce((sum, model) => sum + Object.values(model).reduce((n, fn) => n + (fn as ReturnType<typeof vi.fn>).mock.calls.length, 0), 0);

describe("requireSession", () => {
  it("is null for a session with a user, and a 401 'Not authenticated' without one", async () => {
    mocks.auth.mockResolvedValue(SESSION);
    expect(await requireSession()).toBeNull();

    for (const session of [null, undefined, { expires: "2999-01-01" }, { user: {}, expires: "2999-01-01" }]) {
      mocks.auth.mockResolvedValue(session);
      const denied = await requireSession();
      expect(denied?.status, JSON.stringify(session)).toBe(401);
      expect(await denied?.json()).toEqual({ error: "Not authenticated" });
    }
  });
});

describe.each([
  ["GET /api/domains-tree", getDomainsTree],
  ["GET /api/tenants", getTenants],
])("%s", (_name, handler) => {
  it("answers 401 without a session, even when it is called directly, and queries nothing", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await handler();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
    expect(queriesMade(), "a database query was made for a request without a session").toBe(0);
    expect(mocks.activeTenantId).not.toHaveBeenCalled();
  });

  it("answers 401 for a session without a user", async () => {
    mocks.auth.mockResolvedValue({ expires: "2999-01-01" });
    expect((await handler()).status).toBe(401);
    expect(queriesMade()).toBe(0);
  });

  it("answers its data with a session", async () => {
    mocks.auth.mockResolvedValue(SESSION);
    const response = await handler();
    expect(response.status).toBe(200);
    expect(queriesMade()).toBeGreaterThan(0);
  });
});

describe("what the endpoints answer with a session", () => {
  it("/api/tenants lists the organizations and the active one", async () => {
    mocks.auth.mockResolvedValue(SESSION);
    const body = await (await getTenants()).json();
    expect(body.activeTenantId).toBe("tenant-1");
    expect(body.tenants).toEqual([expect.objectContaining({ id: "tenant-1", name: "Default", domainCount: 2 })]);
  });

  it("/api/domains-tree lists the domains of the active tenant", async () => {
    mocks.auth.mockResolvedValue(SESSION);
    const body = await (await getDomainsTree()).json();
    expect(JSON.stringify(body)).toContain("Billing");
  });
});
