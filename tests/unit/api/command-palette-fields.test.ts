// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  getActiveTenantId: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { field: { findMany: mocks.findMany } } }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
// The tenant being viewed is a cookie of the request: a unit test names it.
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.getActiveTenantId }));

import { NoTenantAccess } from "@/lib/access/no-tenant-access";
import { GET } from "@/app/api/command-palette-fields/route";

const REQUEST = new Request("http://localhost/api/command-palette-fields");
const ROUTE = { params: Promise.resolve({}) };
const call = () => GET(REQUEST, ROUTE);

function fieldRow(entity: Record<string, unknown>) {
  return { id: "f1", slug: "email", name: "email", type: "string", entity };
}

beforeEach(() => {
  vi.clearAllMocks();
  signInAs(tenantMember("VIEWER", "tenant-a"));
  mocks.getActiveTenantId.mockResolvedValue("tenant-a");
});

describe("GET /api/command-palette-fields", () => {
  it("returns the real domain and product slugs for a placed entity", async () => {
    mocks.findMany.mockResolvedValue([
      fieldRow({
        id: "e1",
        name: "Order",
        slug: "order",
        product: { slug: "checkout" },
        domain: { name: "Payments", slug: "payments" },
      }),
    ]);

    const body = await (await call()).json();

    expect(body).toEqual([
      expect.objectContaining({ entitySlug: "order", domainSlug: "payments", productSlug: "checkout" }),
    ]);
  });

  it("returns null slugs (not URL sentinels) for a tenant-level entity", async () => {
    mocks.findMany.mockResolvedValue([
      fieldRow({ id: "e0", name: "Customer", slug: "customer", product: null, domain: null }),
    ]);

    const body = await (await call()).json();

    expect(body[0].domainSlug).toBeNull();
    expect(body[0].productSlug).toBeNull();
  });

  it("asks only for the fields of entities of the tenant being viewed (it used to take the first 100 of every tenant)", async () => {
    mocks.findMany.mockResolvedValue([]);

    await call();

    expect(mocks.getActiveTenantId).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ entity: { tenantId: "tenant-a" } });
    expect(mocks.findMany.mock.calls[0][0].take).toBe(100);
  });

  it("follows the tenant the caller views (one they hold a role in)", async () => {
    signInAs(principalOf([assign.tenant("VIEWER", "tenant-a"), assign.tenant("VIEWER", "tenant-b")]));
    mocks.findMany.mockResolvedValue([]);
    mocks.getActiveTenantId.mockResolvedValue("tenant-b");

    await call();

    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ entity: { tenantId: "tenant-b" } });
  });

  it("a role scoped to a domain or a product finds the fields of THOSE entities only: the restriction is in the query", async () => {
    signInAs(principalOf([assign.domain("VIEWER", "tenant-a", "dom-1"), assign.product("AUTHOR", "tenant-a", "dom-2", "prod-9")]));
    mocks.findMany.mockResolvedValue([]);

    await call();

    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      entity: { tenantId: "tenant-a", OR: [{ domainId: { in: ["dom-1"] } }, { productId: { in: ["prod-9"] } }] },
    });
  });

  it("a platform administrator finds the fields of the tenant in view, and of no other", async () => {
    signInAs(principalOf([assign.global()]));
    mocks.findMany.mockResolvedValue([]);
    await call();
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ entity: { tenantId: "tenant-a" } });
  });

  it("a user with a role in ANOTHER tenant than the one in view finds nothing there: 404, no query", async () => {
    signInAs(tenantMember("ADMIN", "tenant-z"));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("a user with no role at all is a 404 and no query (never a 500), whether or not a tenant can be named", async () => {
    signInAs(roleless());
    expect((await call()).status).toBe(404);
    mocks.getActiveTenantId.mockRejectedValue(new NoTenantAccess());
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests, and queries nothing", async () => {
    signedOut();

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.getActiveTenantId).not.toHaveBeenCalled();
  });

  it("answers a failure of the query with the generic 500 it always had", async () => {
    mocks.findMany.mockRejectedValue(new Error("connection reset"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to fetch fields" });
  });

  it("answers to a session only: the API-key branch was dead (the middleware reads the Cookie header alone, so a Bearer-only caller never gets here) and is gone", async () => {
    mocks.findMany.mockResolvedValue([]);

    // A request with a Bearer key and no session is still decided by the session, and nothing else.
    signedOut();
    process.env.API_KEY = "the-key";
    try {
      const res = await GET(new Request("http://localhost/api/command-palette-fields", { headers: { authorization: "Bearer the-key" } }), ROUTE);
      expect(res.status).toBe(401);
    } finally {
      delete process.env.API_KEY;
    }

    const source = readFileSync(path.resolve(__dirname, "../../../src/app/api/command-palette-fields/route.ts"), "utf8");
    expect(source).not.toContain("authenticateRequest");
    expect(source).not.toMatch(/request\.headers|req\.headers|headers\.get/); // the route reads no header: no Authorization handling
    expect(source).not.toContain("v1/middleware");
  });
});
