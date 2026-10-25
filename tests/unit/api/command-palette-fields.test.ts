import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  requireSession: vi.fn(),
  getActiveTenantId: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { field: { findMany: mocks.findMany } } }));
vi.mock("@/lib/require-session", () => ({ requireSession: mocks.requireSession }));
// The tenant being viewed is a cookie of the request: a unit test names it.
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.getActiveTenantId }));

import { GET } from "@/app/api/command-palette-fields/route";

function fieldRow(entity: Record<string, unknown>) {
  return { id: "f1", slug: "email", name: "email", type: "string", entity };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(null); // a session
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

    const body = await (await GET()).json();

    expect(body).toEqual([
      expect.objectContaining({ entitySlug: "order", domainSlug: "payments", productSlug: "checkout" }),
    ]);
  });

  it("returns null slugs (not URL sentinels) for a tenant-level entity", async () => {
    mocks.findMany.mockResolvedValue([
      fieldRow({ id: "e0", name: "Customer", slug: "customer", product: null, domain: null }),
    ]);

    const body = await (await GET()).json();

    expect(body[0].domainSlug).toBeNull();
    expect(body[0].productSlug).toBeNull();
  });

  it("asks only for the fields of entities of the tenant being viewed (it used to take the first 100 of every tenant)", async () => {
    mocks.findMany.mockResolvedValue([]);

    await GET();

    expect(mocks.getActiveTenantId).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ entity: { tenantId: "tenant-a" } });
    expect(mocks.findMany.mock.calls[0][0].take).toBe(100);
  });

  it("follows the tenant the caller views", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.getActiveTenantId.mockResolvedValue("tenant-b");

    await GET();

    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ entity: { tenantId: "tenant-b" } });
  });

  it("rejects unauthenticated requests, and queries nothing", async () => {
    mocks.requireSession.mockResolvedValue(Response.json({ error: "Not authenticated" }, { status: 401 }));

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.getActiveTenantId).not.toHaveBeenCalled();
  });

  it("answers to a session only: the API-key branch was dead (the middleware reads the Cookie header alone, so a Bearer-only caller never gets here) and is gone", async () => {
    mocks.findMany.mockResolvedValue([]);

    // A request with a Bearer key and no session is still decided by the session check, and nothing else.
    mocks.requireSession.mockResolvedValue(Response.json({ error: "Not authenticated" }, { status: 401 }));
    expect((await GET()).status).toBe(401);

    const source = readFileSync(path.resolve(__dirname, "../../../src/app/api/command-palette-fields/route.ts"), "utf8");
    expect(source).not.toContain("authenticateRequest");
    expect(source).not.toMatch(/request\.headers|req\.headers|headers\.get/); // the route reads no header: no Authorization handling
    expect(source).not.toContain("v1/middleware");
  });
});
