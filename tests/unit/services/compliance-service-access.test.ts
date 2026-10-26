// @vitest-environment node
/**
 * The compliance service decides with the policy over the caller's assignments (no role names): the Query and Gaps tabs are
 * `compliance.query` / `compliance.gaps` (a compliance officer and above, judged per entity: a domain- or product-scoped role reads only its
 * entities, in the query), the Audit Trail and its export are `compliance.audit` / `compliance.export` over the whole tenant. A steward and an
 * author no longer reach any of it (the spec says COMPLIANCE_OFFICER; the old list also let STEWARD and AUTHOR in).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign } from "../../helpers/access-mocks";
import { ROLE_HIERARCHY, type Role } from "@/types/schemas/rbac";
import { roleAtLeast } from "@/lib/access";

const h = vi.hoisted(() => ({
  fieldCount: vi.fn(), fieldFindMany: vi.fn(), auditCount: vi.fn(), auditFindMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: { field: { count: h.fieldCount, findMany: h.fieldFindMany }, auditLog: { count: h.auditCount, findMany: h.auditFindMany } },
}));

import { detectGaps, exportAuditTrail, queryAuditTrail, queryFields } from "@/services/compliance.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";
import type { Assignment } from "@/lib/access";

const T = "tenant-1";
const ctxOf = (assignments: Assignment[]): ServiceContext => ({ userId: "u1", userRole: "VIEWER", assignments, tenantId: T, prisma: prisma as never });
/** A context with no tenant in view (a caller that is not a page). */
const noTenant = (assignments: Assignment[]): ServiceContext => ({ ...ctxOf(assignments), tenantId: undefined });

beforeEach(() => {
  vi.clearAllMocks();
  h.fieldCount.mockResolvedValue(0);
  h.fieldFindMany.mockResolvedValue([]);
  h.auditCount.mockResolvedValue(0);
  h.auditFindMany.mockResolvedValue([]);
});

const TENANT_OPS: Array<{ label: string; call: (ctx: ServiceContext) => Promise<{ success: boolean; error?: { code: string; message: string } }>; reads: () => unknown }> = [
  { label: "queryFields", call: (ctx) => queryFields({}, undefined, ctx), reads: () => h.fieldFindMany },
  { label: "detectGaps", call: (ctx) => detectGaps({}, ctx), reads: () => h.fieldFindMany },
  { label: "queryAuditTrail", call: (ctx) => queryAuditTrail({}, undefined, ctx), reads: () => h.auditFindMany },
  { label: "exportAuditTrail", call: (ctx) => exportAuditTrail({}, ctx), reads: () => h.auditFindMany },
];

describe.each(TENANT_OPS)("$label", ({ call, reads }) => {
  it("is open from COMPLIANCE_OFFICER up over the tenant, refused (generic, nothing read) below it", async () => {
    for (const role of ROLE_HIERARCHY as readonly Role[]) {
      vi.clearAllMocks();
      h.fieldCount.mockResolvedValue(0);
      h.fieldFindMany.mockResolvedValue([]);
      h.auditCount.mockResolvedValue(0);
      h.auditFindMany.mockResolvedValue([]);
      const result = await call(ctxOf([assign.tenant(role, T)]));
      if (roleAtLeast(role, "COMPLIANCE_OFFICER")) expect(result.success, role).toBe(true);
      else {
        expect(result.success, role).toBe(false);
        expect(result.error, role).toEqual({ code: "FORBIDDEN", message: "You do not have permission to do this" });
        expect(reads(), `${role} read the database`).toHaveProperty("mock.calls.length", 0);
      }
    }
  });

  it("a platform administrator may, with or without a tenant in view", async () => {
    expect((await call(ctxOf([assign.global()]))).success).toBe(true);
    expect((await call(noTenant([assign.global()]))).success).toBe(true);
  });

  it("nobody, a roleless caller, a role of ANOTHER tenant and a context with no assignments are refused", async () => {
    for (const assignments of [[], [assign.tenant("ADMIN", "tenant-2")]]) expect((await call(ctxOf(assignments))).success).toBe(false);
    expect((await call({ userId: "u1", userRole: "ADMIN", tenantId: T, prisma: prisma as never })).success).toBe(false);
    expect(reads()).toHaveProperty("mock.calls.length", 0);
  });

  it("with no tenant in view only a platform administrator passes (a tenant administrator does not read across tenants)", async () => {
    expect((await call(noTenant([assign.tenant("ADMIN", T)]))).success).toBe(false);
    expect(reads()).toHaveProperty("mock.calls.length", 0);
  });
});

describe("the audit trail needs the whole tenant", () => {
  it("a domain- or product-scoped compliance officer does not reach it, or its export", async () => {
    for (const assignments of [[assign.domain("COMPLIANCE_OFFICER", T, "dom-a")], [assign.product("ADMIN", T, "dom-a", "prod-a")]]) {
      expect((await queryAuditTrail({}, undefined, ctxOf(assignments))).success).toBe(false);
      expect((await exportAuditTrail({}, ctxOf(assignments))).success).toBe(false);
    }
    expect(h.auditFindMany).not.toHaveBeenCalled();
  });
});

describe("Query and Gaps read only the entities the caller's roles cover", () => {
  const entityWhere = () => h.fieldFindMany.mock.calls[0][0].where.entity as Record<string, unknown>;

  it("a domain-scoped compliance officer is confined to its domain in the query (the tenant and the domain filter stay)", async () => {
    const ctx = ctxOf([assign.domain("COMPLIANCE_OFFICER", T, "dom-a"), assign.product("COMPLIANCE_OFFICER", T, "dom-b", "prod-x")]);
    expect((await queryFields({ domains: ["dom-a"] }, undefined, ctx)).success).toBe(true);
    expect(entityWhere()).toEqual({
      AND: [{ OR: [{ domainId: { in: ["dom-a"] } }, { productId: { in: ["prod-x"] } }] }],
      domainId: { in: ["dom-a"] },
      tenantId: T,
    });
    vi.clearAllMocks();
    h.fieldFindMany.mockResolvedValue([]);
    expect((await detectGaps({}, ctx)).success).toBe(true);
    expect(entityWhere()).toEqual({ AND: [{ OR: [{ domainId: { in: ["dom-a"] } }, { productId: { in: ["prod-x"] } }] }], tenantId: T });
  });

  it("a scoped role that is below COMPLIANCE_OFFICER over its domain adds nothing: refused", async () => {
    expect((await queryFields({}, undefined, ctxOf([assign.domain("STEWARD", T, "dom-a")]))).success).toBe(false);
    expect(h.fieldFindMany).not.toHaveBeenCalled();
  });

  it("a tenant-wide role is not restricted", async () => {
    await queryFields({}, undefined, ctxOf([assign.tenant("COMPLIANCE_OFFICER", T)]));
    expect(entityWhere()).toEqual({ tenantId: T });
  });
});
