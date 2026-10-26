// @vitest-environment node
/**
 * POST /api/ai/generate-entity: the domain it describes to the AI provider (its name, its entity names) must be one of the tenant being
 * viewed AND one the caller may write to (`ai.generate`: an author of that domain or above). It used to look the domain up by id alone, so any
 * signed-in user could send another tenant's domain id and have that tenant's entity names sent to the provider. A domain of another tenant, one no
 * role of the caller's covers and a missing one answer exactly alike (404 'Domain not found'); a role that covers it but is too low is a 403.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  getActiveTenantId: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  isAiConfigured: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.getActiveTenantId }));
vi.mock("@/lib/db", () => ({ prisma: { domain: { findFirst: mocks.findFirst, findUnique: mocks.findUnique } } }));
vi.mock("@/services/ai.service", () => ({ isAiConfigured: mocks.isAiConfigured, generateEntityFromDescription: mocks.generate }));

import { NoTenantAccess } from "@/lib/access/no-tenant-access";
import { POST as rawPost } from "@/app/api/ai/generate-entity/route";

const ROUTE = { params: Promise.resolve({}) };
const request = (body: unknown) => new Request("http://localhost/api/ai/generate-entity", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const POST = (req: Request) => rawPost(req, ROUTE);
const BODY = { domainId: "domain-1", description: "an order with a customer and a total" };
const DOMAIN = { id: "domain-1", name: "Billing", entities: [{ name: "Invoice" }, { name: "Payment" }] };

beforeEach(() => {
  vi.clearAllMocks();
  signInAs(principalOf([assign.tenant("AUTHOR", "tenant-a")]));
  mocks.getActiveTenantId.mockResolvedValue("tenant-a");
  mocks.isAiConfigured.mockReturnValue(true);
  mocks.generate.mockResolvedValue({ success: true, data: { name: "Order", fields: [] } });
});

describe("POST /api/ai/generate-entity", () => {
  it("looks the domain up WITHIN the tenant being viewed, and sends only that domain's entity names to the provider", async () => {
    mocks.findFirst.mockResolvedValue(DOMAIN);

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
    signInAs(principalOf([assign.tenant("AUTHOR", "tenant-a"), assign.tenant("AUTHOR", "tenant-b")]));
    mocks.getActiveTenantId.mockResolvedValue("tenant-b");
    mocks.findFirst.mockResolvedValue(null);

    await POST(request(BODY));

    expect(mocks.findFirst.mock.calls[0][0].where.tenantId).toBe("tenant-b");
  });

  it("still answers 401 without a session and queries nothing", async () => {
    signedOut();

    const response = await POST(request(BODY));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
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

describe("who may ask the AI about a domain (ai.generate: an author of the domain or above)", () => {
  it("a user with no role at all is a 404 (never a 500), with or without a tenant to reach, and the domain is never looked up", async () => {
    signInAs(roleless());
    expect((await POST(request(BODY))).status).toBe(404);
    mocks.getActiveTenantId.mockRejectedValue(new NoTenantAccess());
    expect((await POST(request(BODY))).status).toBe(404);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("a viewer is refused (403) before the body is read, and nothing is looked up or sent", async () => {
    signInAs(tenantMember("VIEWER", "tenant-a"));
    const response = await POST(request(BODY));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "You do not have permission to do this" });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("an author of the tenant, a steward, an administrator and a platform administrator may", async () => {
    mocks.findFirst.mockResolvedValue(DOMAIN);
    for (const assignments of [[assign.tenant("AUTHOR", "tenant-a")], [assign.tenant("STEWARD", "tenant-a")], [assign.tenant("ADMIN", "tenant-a")], [assign.global()]]) {
      signInAs(principalOf(assignments));
      expect((await POST(request(BODY))).status, JSON.stringify(assignments)).toBe(200);
    }
  });

  it("an author of ANOTHER domain gets the 404 of a missing domain (a role decides, not the tenant alone), and the provider is asked nothing", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", "tenant-a", "domain-2")]));
    mocks.findFirst.mockResolvedValue(DOMAIN);
    const response = await POST(request(BODY));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Domain not found" });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("an author of THIS domain may, and a viewer of this domain (who has a role there but too low a one for the action) is refused at the guard", async () => {
    mocks.findFirst.mockResolvedValue(DOMAIN);
    signInAs(principalOf([assign.domain("AUTHOR", "tenant-a", "domain-1")]));
    expect((await POST(request(BODY))).status).toBe(200);
    signInAs(principalOf([assign.domain("VIEWER", "tenant-a", "domain-1")]));
    expect((await POST(request(BODY))).status).toBe(403);
  });

  it("an author of the domain who also holds a lower role elsewhere is judged on the domain (the highest covering role)", async () => {
    mocks.findFirst.mockResolvedValue(DOMAIN);
    signInAs(principalOf([assign.tenant("VIEWER", "tenant-a"), assign.domain("AUTHOR", "tenant-a", "domain-1")]));
    expect((await POST(request(BODY))).status).toBe(200);
    // ... and a viewer of the tenant who is an author of ANOTHER domain sees this one but may not use the AI on it: a clean 403, not a 404.
    signInAs(principalOf([assign.tenant("VIEWER", "tenant-a"), assign.domain("AUTHOR", "tenant-a", "domain-2")]));
    const response = await POST(request(BODY));
    expect(response.status).toBe(403);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
});
