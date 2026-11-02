// @vitest-environment node
/**
 * The exports of the compliance pages go through the same guard as the lists (who may call, the tenant in view, the role) and take the same
 * filters, validated the same way. What they answer is every match of the filters up to the cap, with the total and whether it was cut short.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

// Through the REAL guard (`withApiAuth`): only the session, the database, the tenant in view and the services are stand-ins.
const mocks = vi.hoisted(() => ({ activeTenant: vi.fn(), exportFields: vi.fn(), exportAuditTrail: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/active-tenant")>()), getActiveTenantId: mocks.activeTenant }));
vi.mock("@/services/compliance.service", () => ({ exportFields: mocks.exportFields, exportAuditTrail: mocks.exportAuditTrail }));

import { POST as rawFieldsExport } from "@/app/api/compliance/query/export/route";
import { POST as rawAuditExport } from "@/app/api/compliance/audit-trail/export/route";

const ROUTE = { params: Promise.resolve({}) };
const postFields = (req: Request) => rawFieldsExport(req, ROUTE);
const postAudit = (req: Request) => rawAuditExport(req, ROUTE);
/** What the services are handed: the principal's context, with the tenant in view. */
const CTX = expect.objectContaining({ userId: "officer-1", tenantId: "t1", assignments: [assign.tenant("COMPLIANCE_OFFICER", "t1")] });
const request = (body: unknown, raw = false) =>
  new Request("http://localhost/api/compliance/x", { method: "POST", body: raw ? (body as string) : JSON.stringify(body), headers: { "content-type": "application/json" } });
const json = async (res: Response) => (await res.json()) as { success: boolean; error?: string; details?: unknown; data?: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  signInAs(principalOf([assign.tenant("COMPLIANCE_OFFICER", "t1")], { userId: "officer-1" }));
  mocks.activeTenant.mockResolvedValue("t1");
  mocks.exportFields.mockResolvedValue({ success: true, data: { fields: [], total: 0, truncated: false } });
  mocks.exportAuditTrail.mockResolvedValue({ success: true, data: { entries: [], total: 0, truncated: false } });
});

describe("POST /api/compliance/query/export", () => {
  it("passes the filters and the sort of the list to the export, and answers every match with the total and the cap", async () => {
    mocks.exportFields.mockResolvedValue({
      success: true,
      data: { fields: [{ fieldId: "f1" }, { fieldId: "f2" }], total: 12_001, truncated: true },
    });

    const res = await postFields(request({ filters: { textSearch: "email", classifications: ["PII"] }, sort: { sortBy: "fieldName", sortOrder: "desc" } }));

    expect(res.status).toBe(200);
    expect(mocks.exportFields).toHaveBeenCalledWith(
      expect.objectContaining({ textSearch: "email", classifications: ["PII"] }),
      { sortBy: "fieldName", sortOrder: "desc" },
      CTX
    );
    const body = (await res.json()) as { success: boolean; data: { fields: unknown[]; total: number; truncated: boolean; limit: number } };
    expect(body).toMatchObject({ success: true, data: { total: 12_001, truncated: true, limit: 10_000 } });
    expect(body.data.fields).toHaveLength(2);
  });

  it("the sort defaults to the list's, and an empty body is an export of everything the caller reads", async () => {
    const res = await postFields(request("", true));
    expect(res.status).toBe(200);
    expect(mocks.exportFields).toHaveBeenCalledWith({}, { sortBy: "entityName", sortOrder: "asc" }, CTX);
  });

  it.each([
    ["a NUL in a text filter", { filters: { textSearch: "\u0000" } }],
    ["a sort order that is not one", { sort: { sortOrder: "sideways" } }],
    ["a sort field that is not text", { sort: { sortBy: 5 } }],
    ["a domain list of 10,000", { filters: { domains: Array.from({ length: 10_000 }, (_, i) => `d${i}`) } }],
  ])("refuses %s with a 400 in fixed words, and exports nothing", async (_label, body) => {
    const res = await postFields(request(body));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("Invalid request");
    expect(mocks.exportFields).not.toHaveBeenCalled();
  });

  it("an internal failure is a 500 in fixed words, and FORBIDDEN stays 403", async () => {
    mocks.exportFields.mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR", message: "Failed to export fields" } });
    const failed = await postFields(request({}));
    expect(failed.status).toBe(500);
    expect((await json(failed)).error).toBe("Failed to export fields");
    mocks.exportFields.mockResolvedValue({ success: false, error: { code: "FORBIDDEN", message: "no" } });
    expect((await postFields(request({}))).status).toBe(403);
  });

  describe("who may call it: the guard of the Query list", () => {
    it("nobody is a 401 in the compliance shape, and nothing runs", async () => {
      signedOut();
      const res = await postFields(request({}));
      expect([res.status, await json(res)]).toEqual([401, { success: false, error: "Not authenticated" }]);
      expect(mocks.exportFields).not.toHaveBeenCalled();
    });

    it("a user with no role in the tenant in view is a 404, and one with no role at all", async () => {
      signInAs(roleless());
      const { NoTenantAccess } = await import("@/lib/access/no-tenant-access");
      mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
      expect((await postFields(request({}))).status).toBe(404);
      mocks.activeTenant.mockResolvedValue("t1");
      signInAs(tenantMember("COMPLIANCE_OFFICER", "t2"));
      expect((await postFields(request({}))).status).toBe(404);
      expect(mocks.exportFields).not.toHaveBeenCalled();
    });

    it("a viewer, an author and a steward are a 403 and nothing is exported", async () => {
      for (const role of ["VIEWER", "AUTHOR", "STEWARD"] as const) {
        signInAs(tenantMember(role, "t1"));
        expect((await postFields(request({}))).status, role).toBe(403);
      }
      expect(mocks.exportFields).not.toHaveBeenCalled();
    });

    it("a compliance officer and an administrator of the tenant export", async () => {
      for (const role of ["COMPLIANCE_OFFICER", "ADMIN"] as const) {
        signInAs(principalOf([assign.tenant(role, "t1")], { userId: "officer-1" }));
        expect((await postFields(request({}))).status, role).toBe(200);
      }
    });
  });
});

describe("POST /api/compliance/audit-trail/export", () => {
  it("passes the filters to the export, with the dates read as instants (to is exclusive), and answers the cap", async () => {
    mocks.exportAuditTrail.mockResolvedValue({ success: true, data: { entries: [], total: 0, truncated: false } });

    const res = await postAudit(request({ filters: { actionTypes: ["UPDATE"], dateRange: { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" } } }));

    expect(res.status).toBe(200);
    const [filters, ctx] = mocks.exportAuditTrail.mock.calls[0]!;
    expect(filters.actionTypes).toEqual(["UPDATE"]);
    expect(filters.dateRange.from).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(filters.dateRange.to).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(ctx).toMatchObject({ tenantId: "t1" });
    expect(await res.json()).toMatchObject({ success: true, data: { limit: 10_000 } });
  });

  it("a range with one bound, or none, is valid", async () => {
    expect((await postAudit(request({ filters: { dateRange: { from: "2026-10-01" } } }))).status).toBe(200);
    expect((await postAudit(request({ filters: { dateRange: { to: "2026-11-01" } } }))).status).toBe(200);
    expect((await postAudit(request({}))).status).toBe(200);
  });

  it("an invalid date and a NUL in a filter are refused with a 400", async () => {
    expect((await postAudit(request({ filters: { dateRange: { from: "not-a-date" } } }))).status).toBe(400);
    expect((await postAudit(request({ filters: { userId: "u\u0000" } }))).status).toBe(400);
    expect(mocks.exportAuditTrail).not.toHaveBeenCalled();
  });

  it("an internal failure is a 500 in fixed words", async () => {
    mocks.exportAuditTrail.mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR", message: "Failed to export the audit trail" } });
    const res = await postAudit(request({}));
    expect(res.status).toBe(500);
    expect((await json(res)).error).toBe("Failed to export the audit trail");
  });

  it("the audit trail needs the whole tenant: an officer of one domain is a 403, and nobody is a 401", async () => {
    signInAs(principalOf([assign.domain("COMPLIANCE_OFFICER", "t1", "d1")]));
    expect((await postAudit(request({}))).status).toBe(403);
    expect(mocks.exportAuditTrail).not.toHaveBeenCalled();
    signedOut();
    expect((await postAudit(request({}))).status).toBe(401);
  });

  it("a viewer is a 403 and a platform administrator exports the tenant in view", async () => {
    signInAs(tenantMember("VIEWER", "t1"));
    expect((await postAudit(request({}))).status).toBe(403);
    signInAs(principalOf([assign.global()], { userId: "officer-1" }));
    expect((await postAudit(request({}))).status).toBe(200);
    expect(mocks.exportAuditTrail.mock.calls[0].at(-1)).toMatchObject({ tenantId: "t1" });
  });
});
