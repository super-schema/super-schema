import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  authenticateRequest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { field: { findMany: mocks.findMany } } }));
vi.mock("@/app/api/v1/middleware", () => ({ authenticateRequest: mocks.authenticateRequest }));

import { GET } from "@/app/api/command-palette-fields/route";

function fieldRow(entity: Record<string, unknown>) {
  return { id: "f1", slug: "email", name: "email", type: "string", entity };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateRequest.mockResolvedValue({ authenticated: true });
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

    const body = await (await GET(new Request("http://localhost/api/command-palette-fields"))).json();

    expect(body).toEqual([
      expect.objectContaining({ entitySlug: "order", domainSlug: "payments", productSlug: "checkout" }),
    ]);
  });

  it("returns null slugs (not URL sentinels) for a tenant-level entity", async () => {
    mocks.findMany.mockResolvedValue([
      fieldRow({ id: "e0", name: "Customer", slug: "customer", product: null, domain: null }),
    ]);

    const body = await (await GET(new Request("http://localhost/api/command-palette-fields"))).json();

    expect(body[0].domainSlug).toBeNull();
    expect(body[0].productSlug).toBeNull();
  });

  it("rejects unauthenticated requests", async () => {
    mocks.authenticateRequest.mockResolvedValue({ authenticated: false });

    const res = await GET(new Request("http://localhost/api/command-palette-fields"));

    expect(res.status).toBe(401);
  });
});
