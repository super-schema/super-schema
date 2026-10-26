// @vitest-environment node
/**
 * The compliance routes take their filters and pagination from the request body. They used to pass them straight to the queries:
 * `pageSize: 1e9` dumped the table, `page: -1` threw, and a NUL in a text filter came back as Prisma / Postgres text (a 400 whose message was
 * the driver's). The body is validated now; the failures answer in fixed words.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

// Through the REAL guard (`withApiAuth`): only the session, the database, the tenant in view and the services are stand-ins.
const mocks = vi.hoisted(() => ({ activeTenant: vi.fn(), queryFields: vi.fn(), detectGaps: vi.fn(), queryAuditTrail: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/active-tenant")>()), getActiveTenantId: mocks.activeTenant }));
vi.mock("@/services/compliance.service", () => ({ queryFields: mocks.queryFields, detectGaps: mocks.detectGaps, queryAuditTrail: mocks.queryAuditTrail }));

import { POST as rawQuery } from "@/app/api/compliance/query/route";
import { POST as rawGaps } from "@/app/api/compliance/gaps/route";
import { POST as rawAudit } from "@/app/api/compliance/audit-trail/route";

const ROUTE = { params: Promise.resolve({}) };
const postQuery = (req: Request) => rawQuery(req, ROUTE);
const postGaps = (req: Request) => rawGaps(req, ROUTE);
const postAudit = (req: Request) => rawAudit(req, ROUTE);
/** What the services are handed: the principal's context, with the tenant in view. */
const CTX = expect.objectContaining({ userId: "officer-1", tenantId: "t1", assignments: [assign.tenant("COMPLIANCE_OFFICER", "t1")] });
const request = (body: unknown, raw = false) =>
  new Request("http://localhost/api/compliance/x", { method: "POST", body: raw ? (body as string) : JSON.stringify(body), headers: { "content-type": "application/json" } });
const json = async (res: Response) => (await res.json()) as { success: boolean; error?: string; details?: unknown; data?: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  signInAs(principalOf([assign.tenant("COMPLIANCE_OFFICER", "t1")], { userId: "officer-1" }));
  mocks.activeTenant.mockResolvedValue("t1");
  mocks.queryFields.mockResolvedValue({ success: true, data: { fields: [], total: 0 } });
  mocks.detectGaps.mockResolvedValue({ success: true, data: { gaps: [], summary: {} } });
  mocks.queryAuditTrail.mockResolvedValue({ success: true, data: { entries: [], total: 0 } });
});

describe("POST /api/compliance/query", () => {
  it("answers a NUL in a text filter with a 400 in fixed words and never runs the query", async () => {
    const res = await postQuery(request({ filters: { textSearch: "\u0000" } }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request");
    expect(JSON.stringify(body)).not.toMatch(/prisma|postgres|invocation|\\u0000/i);
    expect(mocks.queryFields).not.toHaveBeenCalled();
  });

  it.each([
    ["pageSize 1e9 (dumps the table)", { pageSize: 1e9 }],
    ["pageSize 201 (the cap is 200)", { pageSize: 201 }],
    ["pageSize 0", { pageSize: 0 }],
    ["pageSize -5", { pageSize: -5 }],
    ["pageSize 2.5", { pageSize: 2.5 }],
    ["pageSize as text", { pageSize: "25" }],
    ["page -1 (throws in the query)", { page: -1 }],
    ["page 0", { page: 0 }],
    ["page 1.5", { page: 1.5 }],
    ["page 1e12", { page: 1e12 }],
    ["sortOrder sideways", { sortOrder: "sideways" }],
    ["sortBy with a NUL", { sortBy: "a\u0000b" }],
  ])("refuses %s", async (_label, pagination) => {
    const res = await postQuery(request({ pagination }));
    expect(res.status).toBe(400);
    expect(mocks.queryFields).not.toHaveBeenCalled();
  });

  it.each([
    ["a list of 10,000 domains", { domains: Array.from({ length: 10_000 }, (_, i) => `d${i}`) }],
    ["a domain that is not text", { domains: [1] }],
    ["domains that are not a list", { domains: "d1" }],
    ["a text search of 100 KB", { textSearch: "a".repeat(100_000) }],
    ["a classification with a NUL", { classifications: ["PII\u0000"] }],
    ["an unknown retention range", { retention: "forever" }],
  ])("refuses %s", async (_label, filters) => {
    const res = await postQuery(request({ filters }));
    expect(res.status).toBe(400);
    expect(mocks.queryFields).not.toHaveBeenCalled();
  });

  it.each([[null], [[]], ["x"], [5]])("refuses a body that is not an object (%j)", async (body) => {
    expect((await postQuery(request(body))).status).toBe(400);
    expect(mocks.queryFields).not.toHaveBeenCalled();
  });

  it("passes validated filters and pagination (defaults applied) to the query", async () => {
    const res = await postQuery(request({ filters: { textSearch: "email", classifications: ["PII"], domains: ["d1"] }, pagination: { page: 3, pageSize: 200 } }));
    expect(res.status).toBe(200);
    expect(mocks.queryFields).toHaveBeenCalledWith(
      expect.objectContaining({ textSearch: "email", classifications: ["PII"], domains: ["d1"] }),
      { page: 3, pageSize: 200, sortBy: "entityName", sortOrder: "asc" },
      CTX
    );
  });

  it("an empty or unreadable body is the default query, as before", async () => {
    for (const raw of ["", "not json", "{}"]) {
      mocks.queryFields.mockClear();
      expect((await postQuery(request(raw, true))).status).toBe(200);
      expect(mocks.queryFields).toHaveBeenCalledWith({}, { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" }, CTX);
    }
  });

  it("an internal failure is a 500 in fixed words; FORBIDDEN stays 403; no session stays 401", async () => {
    mocks.queryFields.mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR", message: "Failed to query fields" } });
    const failed = await postQuery(request({}));
    expect(failed.status).toBe(500);
    expect((await json(failed)).error).toBe("Failed to query fields");
    mocks.queryFields.mockResolvedValue({ success: false, error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
    expect((await postQuery(request({}))).status).toBe(403);
    signedOut();
    expect((await postQuery(request({}))).status).toBe(401);
  });
});

// Who may call what (the guard, before the body is read and before any service runs): 401 nobody, 404 no role in the tenant, 403 a role that does
// not reach the page, and the services are handed the principal's own context with the tenant in view (KD-016: the audit trail is that tenant's).
describe("who may call the compliance routes", () => {
  const ROUTES = [
    ["query", postQuery, () => mocks.queryFields],
    ["gaps", postGaps, () => mocks.detectGaps],
    ["audit-trail", postAudit, () => mocks.queryAuditTrail],
  ] as const;

  describe.each(ROUTES)("POST /api/compliance/%s", (_name, post, service) => {
    it("is a 401 in the compliance shape for nobody, and runs nothing", async () => {
      signedOut();
      const res = await post(request({}));
      expect([res.status, await json(res)]).toEqual([401, { success: false, error: "Not authenticated" }]);
      expect(service()).not.toHaveBeenCalled();
    });

    it("is a 404 'Not found' for a user with no role in any tenant (no tenant to reach: never a 500), and for one with no role in the tenant in view", async () => {
      signInAs(roleless());
      const { NoTenantAccess } = await import("@/lib/access/no-tenant-access");
      mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
      const none = await post(request({}));
      expect([none.status, await json(none)]).toEqual([404, { success: false, error: "Not found" }]);
      mocks.activeTenant.mockResolvedValue("t1");
      expect((await post(request({}))).status).toBe(404);
      signInAs(tenantMember("COMPLIANCE_OFFICER", "t2"));
      expect((await post(request({}))).status).toBe(404);
      expect(service()).not.toHaveBeenCalled();
    });

    it("is a 403 for roles that hold no compliance rights in the tenant (a viewer, an author, a steward), and runs nothing", async () => {
      for (const role of ["VIEWER", "AUTHOR", "STEWARD"] as const) {
        signInAs(tenantMember(role, "t1"));
        const res = await post(request({}));
        expect([res.status, await json(res)], role).toEqual([403, { success: false, error: "You do not have permission to do this" }]);
      }
      expect(service()).not.toHaveBeenCalled();
    });

    it("runs for a compliance officer and for an administrator of the tenant, with the principal's context and the tenant in view", async () => {
      for (const role of ["COMPLIANCE_OFFICER", "ADMIN"] as const) {
        signInAs(principalOf([assign.tenant(role, "t1")], { userId: "officer-1" }));
        expect((await post(request({}))).status, role).toBe(200);
      }
      expect(service()).toHaveBeenCalledTimes(2);
      expect(service().mock.calls[0].at(-1)).toMatchObject({ userId: "officer-1", tenantId: "t1" });
    });

    it("answers to a session only: a bearer key is not a credential here", async () => {
      signedOut();
      process.env.API_KEY = "the-key";
      try {
        const res = await post(new Request("http://localhost/api/compliance/x", { method: "POST", body: "{}", headers: { authorization: "Bearer the-key" } }));
        expect(res.status).toBe(401);
      } finally {
        delete process.env.API_KEY;
      }
    });
  });

  it("the audit trail needs the compliance role over the WHOLE tenant: an officer of one domain only is refused (the service decides per entity for Query and Gaps, so there they pass the guard)", async () => {
    signInAs(principalOf([assign.domain("COMPLIANCE_OFFICER", "t1", "d1")]));
    expect((await postAudit(request({}))).status).toBe(403);
    expect((await postQuery(request({}))).status).toBe(200);
    expect((await postGaps(request({}))).status).toBe(200);
  });

  it("a platform administrator reads the audit trail of the tenant in view", async () => {
    signInAs(principalOf([assign.global()], { userId: "officer-1" }));
    expect((await postAudit(request({}))).status).toBe(200);
    expect(mocks.queryAuditTrail.mock.calls[0].at(-1)).toMatchObject({ tenantId: "t1" });
  });
});

describe("POST /api/compliance/gaps", () => {
  it.each([
    ["a domain with a NUL", { domains: ["d\u0000"] }],
    ["more than 1,000 entities", { entities: Array.from({ length: 1001 }, (_, i) => `e${i}`) }],
    ["entities that are not text", { entities: [{}] }],
  ])("refuses %s", async (_label, filters) => {
    const res = await postGaps(request({ filters }));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("Invalid request");
    expect(mocks.detectGaps).not.toHaveBeenCalled();
  });

  it("passes valid filters on, and keeps FORBIDDEN as 403 and an internal failure as 500", async () => {
    expect((await postGaps(request({ filters: { domains: ["d1"], entities: ["e1"] } }))).status).toBe(200);
    expect(mocks.detectGaps).toHaveBeenCalledWith({ domains: ["d1"], entities: ["e1"] }, CTX);
    mocks.detectGaps.mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR", message: "Failed to detect gaps" } });
    expect((await postGaps(request({}))).status).toBe(500);
    mocks.detectGaps.mockResolvedValue({ success: false, error: { code: "FORBIDDEN", message: "no" } });
    expect((await postGaps(request({}))).status).toBe(403);
  });
});

describe("POST /api/compliance/audit-trail", () => {
  it.each([
    ["entityName with a NUL", { filters: { entityName: "a\u0000" } }],
    ["a userId with a NUL", { filters: { userId: "u\u0000" } }],
    ["an invalid date", { filters: { dateRange: { from: "not-a-date", to: "2026-01-01" } } }],
    ["100 action types", { filters: { actionTypes: Array.from({ length: 100 }, (_, i) => `A${i}`) } }],
    ["pageSize 1e9", { pagination: { pageSize: 1e9 } }],
    ["page -1", { pagination: { page: -1 } }],
  ])("refuses %s", async (_label, body) => {
    const res = await postAudit(request(body));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("Invalid request");
    expect(mocks.queryAuditTrail).not.toHaveBeenCalled();
  });

  it("passes valid filters on with the default pagination, and an internal failure is a 500", async () => {
    const res = await postAudit(request({ filters: { actionTypes: ["UPDATE"], entityName: "ent", dateRange: { from: "2026-01-01", to: "2026-02-01" } } }));
    expect(res.status).toBe(200);
    const [filters, pagination] = mocks.queryAuditTrail.mock.calls[0]!;
    expect(filters.actionTypes).toEqual(["UPDATE"]);
    expect(filters.dateRange.from).toBeInstanceOf(Date);
    expect(pagination).toEqual({ page: 1, pageSize: 50 });
    mocks.queryAuditTrail.mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR", message: "Failed to query audit trail" } });
    expect((await postAudit(request({}))).status).toBe(500);
  });
});
