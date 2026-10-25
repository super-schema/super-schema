// @vitest-environment node
/**
 * The compliance routes take their filters and pagination from the request body. They used to pass them straight to the queries:
 * `pageSize: 1e9` dumped the table, `page: -1` threw, and a NUL in a text filter came back as Prisma / Postgres text (a 400 whose message was
 * the driver's). The body is validated now; the failures answer in fixed words.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveContext: vi.fn(), queryFields: vi.fn(), detectGaps: vi.fn(), queryAuditTrail: vi.fn() }));
vi.mock("@/app/api/compliance/_context", () => ({ resolveContext: mocks.resolveContext }));
vi.mock("@/services/compliance.service", () => ({ queryFields: mocks.queryFields, detectGaps: mocks.detectGaps, queryAuditTrail: mocks.queryAuditTrail }));

import { POST as postQuery } from "@/app/api/compliance/query/route";
import { POST as postGaps } from "@/app/api/compliance/gaps/route";
import { POST as postAudit } from "@/app/api/compliance/audit-trail/route";

const CTX = { userId: "u1", userRole: "AUTHOR", tenantId: "t1", prisma: {} };
const request = (body: unknown, raw = false) =>
  new Request("http://localhost/api/compliance/x", { method: "POST", body: raw ? (body as string) : JSON.stringify(body), headers: { "content-type": "application/json" } });
const json = async (res: Response) => (await res.json()) as { success: boolean; error?: string; details?: unknown; data?: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveContext.mockResolvedValue({ ok: true, ctx: CTX });
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
    mocks.resolveContext.mockResolvedValue({ ok: false, status: 401, message: "Not authenticated" });
    expect((await postQuery(request({}))).status).toBe(401);
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
