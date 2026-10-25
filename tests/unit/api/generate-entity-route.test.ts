// @vitest-environment node
/**
 * POST /api/ai/generate-entity: the domain it describes to the AI provider (its name, its entity names) must be one of the tenant being
 * viewed. It used to look the domain up by id alone, so any signed-in user could send another tenant's domain id and have that tenant's
 * entity names sent to the provider. A domain of another tenant answers exactly like one that does not exist.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getActiveTenantId: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  isAiConfigured: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("@/lib/require-session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.getActiveTenantId }));
vi.mock("@/lib/db", () => ({ prisma: { domain: { findFirst: mocks.findFirst, findUnique: mocks.findUnique } } }));
vi.mock("@/services/ai.service", () => ({ isAiConfigured: mocks.isAiConfigured, generateEntityFromDescription: mocks.generate }));

import { POST } from "@/app/api/ai/generate-entity/route";

const request = (body: unknown) => new Request("http://localhost/api/ai/generate-entity", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const BODY = { domainId: "domain-1", description: "an order with a customer and a total" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(null);
  mocks.getActiveTenantId.mockResolvedValue("tenant-a");
  mocks.isAiConfigured.mockReturnValue(true);
  mocks.generate.mockResolvedValue({ success: true, data: { name: "Order", fields: [] } });
});

describe("POST /api/ai/generate-entity", () => {
  it("looks the domain up WITHIN the tenant being viewed, and sends only that domain's entity names to the provider", async () => {
    mocks.findFirst.mockResolvedValue({ id: "domain-1", name: "Billing", entities: [{ name: "Invoice" }, { name: "Payment" }] });

    const response = await POST(request(BODY));

    expect(response.status).toBe(200);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.findFirst.mock.calls[0][0].where).toEqual({ id: "domain-1", tenantId: "tenant-a" });
    expect(mocks.findUnique, "a lookup by id alone is the leak").not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledWith(BODY.description, { domainName: "Billing", existingEntityNames: ["Invoice", "Payment"] });
  });

  it("answers a domain of ANOTHER tenant exactly like a domain that does not exist (404 'Domain not found'), and asks the provider nothing", async () => {
    // The query is scoped by tenant: the other tenant's domain is simply not found.
    mocks.findFirst.mockResolvedValue(null);

    const response = await POST(request({ ...BODY, domainId: "domain-of-tenant-b" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Domain not found" });
    expect(mocks.findFirst.mock.calls[0][0].where).toEqual({ id: "domain-of-tenant-b", tenantId: "tenant-a" });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("follows the tenant the caller views", async () => {
    mocks.getActiveTenantId.mockResolvedValue("tenant-b");
    mocks.findFirst.mockResolvedValue(null);

    await POST(request(BODY));

    expect(mocks.findFirst.mock.calls[0][0].where.tenantId).toBe("tenant-b");
  });

  it("still answers 401 without a session and queries nothing", async () => {
    mocks.requireSession.mockResolvedValue(Response.json({ error: "Not authenticated" }, { status: 401 }));

    const response = await POST(request(BODY));

    expect(response.status).toBe(401);
    expect(mocks.getActiveTenantId).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("still answers 503 when the AI is not configured, before it looks at any domain", async () => {
    mocks.isAiConfigured.mockReturnValue(false);

    const response = await POST(request(BODY));

    expect(response.status).toBe(503);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });
});
