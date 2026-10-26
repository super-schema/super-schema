import { describe, it, expect, beforeEach, vi } from "vitest";

// The service reads the active tenant from the request's cookie and creates the default tenant on a fresh install: both are the
// concern of other modules (and need a request), so they are fixed here. `withAudit` is a pass-through (it writes the audit log).
const ACTIVE_TENANT = "tenant-a";
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn(async () => ACTIVE_TENANT) }));
vi.mock("@/lib/org-defaults", () => ({ ensureDefaultTenantId: vi.fn(async () => "tenant_default"), DEFAULT_TENANT_ID: "tenant_default" }));
vi.mock("@/lib/audit", () => ({
  AuditUserMissingError: class AuditUserMissingError extends Error {},
  withAudit: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => fn()),
}));

import {
  getDomainsAdmin,
  getDomainAdminById,
  createDomainAdmin,
  updateDomainAdmin,
  deleteDomainAdmin,
  applyPolicyTemplate,
  removeInheritance,
  type DomainRecord,
} from "@/services/domain-admin.service";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import type { ServiceContext } from "@/types/service-context";
import { assign } from "../../helpers/access-mocks";

// ---------------------------------------------------------------------------
// A small stateful stand-in for the `domain` Prisma delegate. Its rows live here (the "database"), not in the service: a service that
// kept its own store would fail the tests that read what another call (or another "process") wrote.
// ---------------------------------------------------------------------------
interface Row {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string;
  policyTemplate: unknown;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count: { entities: number; products: number; traits: number; eventSpecs: number };
}

let rows: Row[] = [];
let nextId = 1;

type Where = { id?: string | { not: string }; tenantId?: string; slug?: string; name?: string | { equals: string; mode: "insensitive" } };

function matches(row: Row, where: Where = {}): boolean {
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
  if (typeof where.id === "string" && row.id !== where.id) return false;
  if (typeof where.id === "object" && row.id === where.id.not) return false;
  if (typeof where.name === "string" && row.name !== where.name) return false;
  if (typeof where.name === "object" && row.name.toLowerCase() !== where.name.equals.toLowerCase()) return false;
  if (where.slug !== undefined && row.slug !== where.slug) return false;
  return true;
}

const fakePrisma = {
  domain: {
    findMany: vi.fn(async (args: { where?: Where }) =>
      // The service's own order: system domains first, then by name.
      rows.filter((r) => matches(r, args.where)).sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name)),
    ),
    // A copy, as the database answers: the audit entry's "before" must not change when the row is written afterwards.
    findFirst: vi.fn(async (args: { where?: Where }) => {
      const found = rows.find((r) => matches(r, args.where));
      return found ? { ...found, _count: { ...found._count } } : null;
    }),
    create: vi.fn(async (args: { data: Partial<Row> & { name: string; slug: string; tenantId: string } }) => {
      if (rows.some((r) => r.tenantId === args.data.tenantId && (r.slug === args.data.slug || r.name === args.data.name))) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row: Row = {
        id: `dom-${nextId++}`,
        description: "",
        policyTemplate: null,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { entities: 0, products: 0, traits: 0, eventSpecs: 0 },
        ...args.data,
      };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
      if (args.data.slug && rows.some((r) => r.id !== row.id && r.tenantId === row.tenantId && r.slug === args.data.slug)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    }),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      rows = rows.filter((r) => r.id !== args.where.id);
      return null;
    }),
  },
};

const adminCtx: ServiceContext = { userId: "admin-1", userRole: "ADMIN", assignments: [assign.global()], prisma: fakePrisma as unknown as ServiceContext["prisma"] };
const ctxWith = (assignments: ServiceContext["assignments"]): ServiceContext => ({ userId: "user-x", userRole: "VIEWER", assignments, prisma: fakePrisma as unknown as ServiceContext["prisma"] });
// A viewer of the tenant in view, and somebody who holds a role in ANOTHER tenant only.
const viewerCtx = ctxWith([assign.tenant("VIEWER", ACTIVE_TENANT)]);
const strangerCtx = ctxWith([assign.tenant("ADMIN", "tenant-z")]);

function seed(partial: Partial<Row> & { name: string }): Row {
  const row: Row = {
    id: `dom-${nextId++}`,
    tenantId: ACTIVE_TENANT,
    slug: partial.name.toLowerCase().replace(/\s+/g, "-"),
    description: "",
    policyTemplate: null,
    isSystem: false,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    _count: { entities: 0, products: 0, traits: 0, eventSpecs: 0 },
    ...partial,
  };
  rows.push(row);
  return row;
}

describe("Domain Admin Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    nextId = 1;
  });

  describe("getDomainsAdmin", () => {
    it("lists the domains of the database in the active tenant: system domains first, then by name, with entity counts and template status", async () => {
      seed({ name: "Zeta", _count: { entities: 3, products: 1, traits: 0, eventSpecs: 0 } });
      seed({ name: "Alpha", policyTemplate: { classification: "PII" } });
      seed({ name: "Public", isSystem: true });
      seed({ name: "Other tenant", tenantId: "tenant-b" });

      const result = await getDomainsAdmin(adminCtx);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.map((d) => d.name)).toEqual(["Public", "Alpha", "Zeta"]);
      expect(result.data.find((d) => d.name === "Zeta")!.entityCount).toBe(3);
      expect(result.data.find((d) => d.name === "Alpha")!.policyTemplateStatus).toBe("Configured");
      expect(result.data.find((d) => d.name === "Alpha")!.policyTemplate).toEqual({ classification: "PII" });
      expect(result.data.find((d) => d.name === "Zeta")!.policyTemplateStatus).toBe("No template");
      expect(result.data.find((d) => d.name === "Public")!.isSystem).toBe(true);
      expect(fakePrisma.domain.findMany.mock.calls[0][0].where).toEqual({ tenantId: ACTIVE_TENANT });
    });

    it("treats a stored policy template that is not a template as no template", async () => {
      seed({ name: "Odd", policyTemplate: { classification: "NOT_A_LEVEL" } });
      const result = await getDomainsAdmin(adminCtx);
      expect(result.success && result.data[0].policyTemplate).toBeNull();
      expect(result.success && result.data[0].policyTemplateStatus).toBe("No template");
    });

    // FINAL WAVE 2b, G9: a template stored with a fractional retention period (stored before the editor required a whole number) is still
    // a template: it is read with the period rounded UP to a whole number (at least 1), and nothing is rewritten.
    it.each([
      [0.5, 1],
      [1.2, 2],
      [2.5, 3],
      [7, 7],
    ])("a stored template with a retention period of %s is read as a template with a period of %s, not as no template", async (stored, read) => {
      const policyTemplate = { classification: "PII", retentionPolicy: { strategy: "age-based", period: stored, periodUnit: "months", action: "delete" } };
      seed({ name: "Legacy", policyTemplate });
      const result = await getDomainsAdmin(adminCtx);
      expect(result.success && result.data[0].policyTemplateStatus).toBe("Configured");
      expect(result.success && result.data[0].policyTemplate).toEqual({ classification: "PII", retentionPolicy: { strategy: "age-based", period: read, periodUnit: "months", action: "delete" } });
      // no data change: the stored value is what it was
      expect(policyTemplate.retentionPolicy.period).toBe(stored);
    });

    it("a template whose other parts are wrong is still no template (only the period is tolerated)", async () => {
      seed({ name: "Odd", policyTemplate: { retentionPolicy: { strategy: "forever", period: 0.5, action: "delete" } } });
      const result = await getDomainsAdmin(adminCtx);
      expect(result.success && result.data[0].policyTemplateStatus).toBe("No template");
    });

    it("rejects somebody with no role in the tenant", async () => {
      const result = await getDomainsAdmin(strangerCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("FORBIDDEN");
      expect(fakePrisma.domain.findMany).not.toHaveBeenCalled();
    });
  });

  describe("getDomainAdminById", () => {
    it("returns a domain of the active tenant", async () => {
      const row = seed({ name: "Finance", description: "Money" });
      const result = await getDomainAdminById(row.id, adminCtx);
      expect(result.success && result.data.name).toBe("Finance");
    });

    it("answers a domain of another tenant exactly like a missing one", async () => {
      const foreign = seed({ name: "Foreign", tenantId: "tenant-b" });
      const foreignResult = await getDomainAdminById(foreign.id, adminCtx);
      const missingResult = await getDomainAdminById("nope", adminCtx);
      expect(foreignResult.success).toBe(false);
      expect(!foreignResult.success && foreignResult.error.code).toBe("NOT_FOUND");
      expect(!missingResult.success && missingResult.error.code).toBe("NOT_FOUND");
    });
  });

  describe("createDomainAdmin", () => {
    it("creates a domain with a policy template, in the active tenant, with the slug of its name", async () => {
      const result = await createDomainAdmin(
        { name: "Finance Ops", description: "Financial data", policyTemplate: { classification: "SENSITIVE", retention: "7 years" } },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Finance Ops");
        expect(result.data.description).toBe("Financial data");
        expect(result.data.isSystem).toBe(false);
        expect(result.data.policyTemplate).toEqual({ classification: "SENSITIVE", retention: "7 years" });
      }
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId: ACTIVE_TENANT, slug: "finance-ops", name: "Finance Ops", isSystem: false });
    });

    it("creates a domain without a policy template", async () => {
      const result = await createDomainAdmin({ name: "General" }, adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.policyTemplate).toBeNull();
        expect(result.data.description).toBe("");
      }
    });

    it("a created domain is what the sidebar reads (the tenant's domain rows) and survives a restart of the service", async () => {
      const created = await createDomainAdmin({ name: "Payments Admin" }, adminCtx);
      expect(created.success).toBe(true);

      // The sidebar: /api/domains-tree reads `domain.findMany({ where: { tenantId } })`.
      const sidebar = await fakePrisma.domain.findMany({ where: { tenantId: ACTIVE_TENANT } });
      expect(sidebar.map((d) => d.name)).toContain("Payments Admin");

      // A restart loses every module-level variable and keeps the database: load the service again, from nothing.
      vi.resetModules();
      const restarted = await import("@/services/domain-admin.service");
      const listed = await restarted.getDomainsAdmin(adminCtx);
      expect(listed.success && listed.data.map((d) => d.name)).toContain("Payments Admin");
    });

    it("rejects a duplicate domain name (case-insensitive) without writing", async () => {
      await createDomainAdmin({ name: "Finance" }, adminCtx);
      fakePrisma.domain.create.mockClear();
      const result = await createDomainAdmin({ name: "finance" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("DUPLICATE");
      expect(fakePrisma.domain.create).not.toHaveBeenCalled();
    });

    it("answers a clash the database finds (the same slug from another spelling) as DUPLICATE, not as a crash", async () => {
      await createDomainAdmin({ name: "Order Data" }, adminCtx);
      const result = await createDomainAdmin({ name: "order-data" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("DUPLICATE");
    });

    it("allows the name of a domain that another tenant has", async () => {
      seed({ name: "Finance", tenantId: "tenant-b" });
      const result = await createDomainAdmin({ name: "Finance" }, adminCtx);
      expect(result.success).toBe(true);
    });

    it("refuses a name whose slug is a reserved schemas route", async () => {
      const result = await createDomainAdmin({ name: "Type Mappings" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("reserved");
      }
      expect(rows).toHaveLength(0);
    });

    it("refuses a name that has no letters or digits (no slug)", async () => {
      const result = await createDomainAdmin({ name: "!!!" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(rows).toHaveLength(0);
    });

    it("rejects non-Admin users and writes nothing", async () => {
      const result = await createDomainAdmin({ name: "Test" }, viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("FORBIDDEN");
      expect(rows).toHaveLength(0);
    });

    it("rejects an empty name", async () => {
      const result = await createDomainAdmin({ name: "" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("updateDomainAdmin", () => {
    it("updates name (and the slug that follows it), description, and policy template", async () => {
      const original = seed({ name: "Original" });
      const result = await updateDomainAdmin(
        { id: original.id, name: "Updated", description: "New description", policyTemplate: { classification: "PII" } },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Updated");
        expect(result.data.description).toBe("New description");
        expect(result.data.policyTemplate).toEqual({ classification: "PII" });
      }
      expect(rows[0]).toMatchObject({ name: "Updated", slug: "updated", description: "New description" });
    });

    it("leaves what the input does not name alone", async () => {
      const original = seed({ name: "Keep", description: "Stays", policyTemplate: { classification: "PII" } });
      const result = await updateDomainAdmin({ id: original.id, description: "Changed" }, adminCtx);
      expect(result.success).toBe(true);
      expect(rows[0]).toMatchObject({ name: "Keep", slug: "keep", description: "Changed", policyTemplate: { classification: "PII" } });
    });

    it("rejects a duplicate name on update (case-insensitive)", async () => {
      seed({ name: "First" });
      const second = seed({ name: "Second" });
      const result = await updateDomainAdmin({ id: second.id, name: "first" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("DUPLICATE");
      expect(rows.find((r) => r.id === second.id)!.name).toBe("Second");
    });

    it("does not rename a system domain (its name is what the app finds it by)", async () => {
      const system = seed({ name: "Public", isSystem: true });
      const result = await updateDomainAdmin({ id: system.id, name: "Everyone" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("CONFLICT");
      expect(rows[0].name).toBe("Public");
    });

    it("lets a system domain's description and policy template change", async () => {
      const system = seed({ name: "Public", isSystem: true });
      const result = await updateDomainAdmin({ id: system.id, description: "Shared", policyTemplate: { classification: "PUBLIC" } }, adminCtx);
      expect(result.success).toBe(true);
      expect(rows[0]).toMatchObject({ name: "Public", description: "Shared" });
    });

    it("answers a domain of another tenant exactly like a missing one and writes nothing", async () => {
      const foreign = seed({ name: "Foreign", tenantId: "tenant-b" });
      const result = await updateDomainAdmin({ id: foreign.id, name: "Mine now" }, adminCtx);
      expect(!result.success && result.error.code).toBe("NOT_FOUND");
      expect(rows[0].name).toBe("Foreign");
      expect(fakePrisma.domain.update).not.toHaveBeenCalled();
    });

    it("rejects non-Admin users", async () => {
      const row = seed({ name: "Locked" });
      const result = await updateDomainAdmin({ id: row.id, name: "Hacked" }, viewerCtx);
      expect(!result.success && result.error.code).toBe("FORBIDDEN");
      expect(rows[0].name).toBe("Locked");
    });
  });

  describe("deleteDomainAdmin", () => {
    it("deletes a domain with no entities", async () => {
      const row = seed({ name: "Empty" });
      const result = await deleteDomainAdmin(row.id, adminCtx);
      expect(result.success).toBe(true);
      expect(rows).toHaveLength(0);
    });

    it("blocks deletion when entities exist", async () => {
      const row = seed({ name: "HasEntities", _count: { entities: 5, products: 1, traits: 0, eventSpecs: 0 } });
      const result = await deleteDomainAdmin(row.id, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("CONFLICT");
        expect(result.error.message).toContain("5 entities");
      }
      expect(rows).toHaveLength(1);
    });

    it("blocks deletion when the domain still owns events", async () => {
      const row = seed({ name: "HasEvents", _count: { entities: 0, products: 1, traits: 0, eventSpecs: 2 } });
      const result = await deleteDomainAdmin(row.id, adminCtx);
      expect(!result.success && result.error.code).toBe("CONFLICT");
      expect(rows).toHaveLength(1);
    });

    it("never deletes a system domain", async () => {
      const row = seed({ name: "Playground", isSystem: true });
      const result = await deleteDomainAdmin(row.id, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("CONFLICT");
        expect(result.error.message).toMatch(/system domain/i);
      }
      expect(rows).toHaveLength(1);
    });

    it("answers a domain of another tenant exactly like a missing one and deletes nothing", async () => {
      const foreign = seed({ name: "Foreign", tenantId: "tenant-b" });
      const result = await deleteDomainAdmin(foreign.id, adminCtx);
      expect(!result.success && result.error.code).toBe("NOT_FOUND");
      expect(rows).toHaveLength(1);
      expect(fakePrisma.domain.delete).not.toHaveBeenCalled();
    });

    it("rejects non-Admin users", async () => {
      const row = seed({ name: "Keep" });
      const result = await deleteDomainAdmin(row.id, viewerCtx);
      expect(!result.success && result.error.code).toBe("FORBIDDEN");
      expect(rows).toHaveLength(1);
    });
  });

  describe("who may do what (the policy over the caller's assignments)", () => {
    it("reading: a viewer of the tenant reads a domain; somebody with no role in it reads it as missing, a list is refused them", async () => {
      const row = seed({ name: "Finance" });
      expect((await getDomainAdminById(row.id, viewerCtx)).success).toBe(true);
      const hidden = await getDomainAdminById(row.id, strangerCtx);
      const missing = await getDomainAdminById("nonexistent", strangerCtx);
      expect(JSON.stringify(hidden).replace(row.id, "<id>")).toBe(JSON.stringify(missing).replace("nonexistent", "<id>"));
      expect(!hidden.success && hidden.error.code).toBe("NOT_FOUND");
      const list = await getDomainsAdmin(strangerCtx);
      expect(!list.success && list.error.code).toBe("FORBIDDEN");
      expect(fakePrisma.domain.findMany).not.toHaveBeenCalled();
    });

    it("the list holds the domains the caller's roles cover: every one for a tenant-wide role, only its own for a domain-scoped one", async () => {
      const a = seed({ name: "Alpha" });
      seed({ name: "Beta" });
      const all = await getDomainsAdmin(viewerCtx);
      expect(all.success && all.data.map((d) => d.name)).toEqual(["Alpha", "Beta"]);
      const own = await getDomainsAdmin(ctxWith([assign.domain("VIEWER", ACTIVE_TENANT, a.id)]));
      expect(own.success && own.data.map((d) => d.name)).toEqual(["Alpha"]);
    });

    it("creating is a steward's act over the whole tenant (a compliance officer and an administrator too): nothing is written below it", async () => {
      for (const role of ["VIEWER", "AUTHOR"] as const) {
        const result = await createDomainAdmin({ name: "Nope" }, ctxWith([assign.tenant(role, ACTIVE_TENANT)]));
        expect(!result.success && result.error, role).toEqual(expect.objectContaining({ code: "FORBIDDEN", message: "You do not have permission to do this" }));
      }
      expect((await createDomainAdmin({ name: "S" }, ctxWith([assign.domain("STEWARD", ACTIVE_TENANT, "dom-x")]))).success).toBe(false);
      expect((await createDomainAdmin({ name: "N" }, strangerCtx)).success).toBe(false);
      expect(fakePrisma.domain.create).not.toHaveBeenCalled();
      for (const role of ["STEWARD", "COMPLIANCE_OFFICER", "ADMIN"] as const) {
        expect((await createDomainAdmin({ name: `By ${role}` }, ctxWith([assign.tenant(role, ACTIVE_TENANT)]))).success, role).toBe(true);
      }
    });

    it("updating is a steward's act over THE DOMAIN: a steward of the domain may, of a sibling domain it reads as missing, an author is refused", async () => {
      const mine = seed({ name: "Mine" });
      const sibling = seed({ name: "Sibling" });
      expect((await updateDomainAdmin({ id: mine.id, description: "x" }, ctxWith([assign.domain("STEWARD", ACTIVE_TENANT, mine.id)]))).success).toBe(true);
      const wrong = await updateDomainAdmin({ id: sibling.id, description: "x" }, ctxWith([assign.domain("STEWARD", ACTIVE_TENANT, mine.id)]));
      expect(!wrong.success && wrong.error.code).toBe("NOT_FOUND");
      const low = await updateDomainAdmin({ id: mine.id, description: "x" }, ctxWith([assign.domain("AUTHOR", ACTIVE_TENANT, mine.id)]));
      expect(!low.success && low.error.code).toBe("FORBIDDEN");
      expect(rows.find((r) => r.id === sibling.id)!.description).toBe("");
    });

    it("deleting is a tenant administrator's act: a domain administrator and a steward do not reach it", async () => {
      const row = seed({ name: "Doomed" });
      for (const ctx of [ctxWith([assign.domain("ADMIN", ACTIVE_TENANT, row.id)]), ctxWith([assign.tenant("STEWARD", ACTIVE_TENANT)]), strangerCtx]) {
        const result = await deleteDomainAdmin(row.id, ctx);
        expect(!result.success && result.error.code).toBe("FORBIDDEN");
      }
      expect(fakePrisma.domain.delete).not.toHaveBeenCalled();
      expect((await deleteDomainAdmin(row.id, ctxWith([assign.tenant("ADMIN", ACTIVE_TENANT)]))).success).toBe(true);
    });

    it("works in the tenant the action put in the context, not another one read from the cookie", async () => {
      seed({ name: "Here" });
      seed({ name: "Elsewhere", tenantId: "tenant-b" });
      const list = await getDomainsAdmin({ ...ctxWith([assign.global()]), tenantId: "tenant-b" });
      expect(list.success && list.data.map((d) => d.name)).toEqual(["Elsewhere"]);
    });
  });

  describe("audit trail", () => {
    it("create writes one audit entry for the acting user", async () => {
      await createDomainAdmin({ name: "Audited" }, adminCtx);

      expect(withAudit).toHaveBeenCalledTimes(1);
      expect(vi.mocked(withAudit).mock.calls[0][0]).toMatchObject({ action: "CREATE", entityType: "Domain", userId: "admin-1" });
    });

    it("update writes one audit entry that carries the domain as it was", async () => {
      const row = seed({ name: "Before", description: "old text" });
      await updateDomainAdmin({ id: row.id, description: "new text" }, adminCtx);

      expect(withAudit).toHaveBeenCalledTimes(1);
      const call = vi.mocked(withAudit).mock.calls[0][0];
      expect(call).toMatchObject({ action: "UPDATE", entityType: "Domain", entityId: row.id, userId: "admin-1" });
      expect(call.beforeState).toMatchObject({ id: row.id, name: "Before", description: "old text" });
    });

    it("delete writes one audit entry that carries the domain as it was", async () => {
      const row = seed({ name: "Doomed" });
      await deleteDomainAdmin(row.id, adminCtx);

      expect(withAudit).toHaveBeenCalledTimes(1);
      const call = vi.mocked(withAudit).mock.calls[0][0];
      expect(call).toMatchObject({ action: "DELETE", entityType: "Domain", entityId: row.id, userId: "admin-1" });
      expect(call.beforeState).toMatchObject({ id: row.id, name: "Doomed" });
    });

    it("a refused call writes no audit entry: a role, a validation, a missing domain, a system rename, a blocked delete", async () => {
      const system = seed({ name: "Public", isSystem: true });
      const busy = seed({ name: "Busy", _count: { entities: 1, products: 0, traits: 0, eventSpecs: 0 } });
      await createDomainAdmin({ name: "Nope" }, viewerCtx);
      await createDomainAdmin({ name: "!!!" }, adminCtx);
      await updateDomainAdmin({ id: "missing", name: "X" }, adminCtx);
      await updateDomainAdmin({ id: system.id, name: "Everyone" }, adminCtx);
      await deleteDomainAdmin(busy.id, adminCtx);
      await deleteDomainAdmin(system.id, adminCtx);

      expect(withAudit).not.toHaveBeenCalled();
    });

    it("create, update and delete tell a session whose user no longer exists to sign in again, and change nothing", async () => {
      const row = seed({ name: "Keep" });
      // One failure for each of the three calls below (a plain mockRejectedValue would outlive this test).
      for (let i = 0; i < 3; i++) vi.mocked(withAudit).mockRejectedValueOnce(new AuditUserMissingError("gone"));

      const created = await createDomainAdmin({ name: "Ghost" }, adminCtx);
      const updated = await updateDomainAdmin({ id: row.id, name: "Renamed" }, adminCtx);
      const deleted = await deleteDomainAdmin(row.id, adminCtx);

      for (const result of [created, updated, deleted]) {
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.code).toBe("UNAUTHORIZED");
      }
      expect(rows.map((r) => r.name)).toEqual(["Keep"]);
    });
  });

  describe("a database that answers with a code", () => {
    it("update: the domain deleted between the read and the write (P2025) is NOT_FOUND", async () => {
      const row = seed({ name: "Vanishing" });
      fakePrisma.domain.update.mockRejectedValueOnce(Object.assign(new Error("Record to update not found."), { code: "P2025" }));

      const result = await updateDomainAdmin({ id: row.id, description: "x" }, adminCtx);
      expect(!result.success && result.error.code).toBe("NOT_FOUND");
    });

    it("delete: the same, NOT_FOUND", async () => {
      const row = seed({ name: "Vanishing" });
      fakePrisma.domain.delete.mockRejectedValueOnce(Object.assign(new Error("Record to delete does not exist."), { code: "P2025" }));

      const result = await deleteDomainAdmin(row.id, adminCtx);
      expect(!result.success && result.error.code).toBe("NOT_FOUND");
    });

    it("update: a clash the unique index finds (the same slug from another spelling) is DUPLICATE", async () => {
      seed({ name: "Order Data" });
      const other = seed({ name: "Something Else" });

      const result = await updateDomainAdmin({ id: other.id, name: "order-data" }, adminCtx);
      expect(!result.success && result.error.code).toBe("DUPLICATE");
      expect(rows.find((r) => r.id === other.id)!.name).toBe("Something Else");
    });

    it("update and delete let a failure they do not know THROW (never a quiet NOT_FOUND)", async () => {
      const row = seed({ name: "Unlucky" });
      fakePrisma.domain.update.mockRejectedValueOnce(Object.assign(new Error("connection lost"), { code: "P1001" }));
      await expect(updateDomainAdmin({ id: row.id, description: "x" }, adminCtx)).rejects.toThrow("connection lost");
      fakePrisma.domain.delete.mockRejectedValueOnce(Object.assign(new Error("connection lost"), { code: "P1001" }));
      await expect(deleteDomainAdmin(row.id, adminCtx)).rejects.toThrow("connection lost");
    });
  });

  describe("applyPolicyTemplate", () => {
    it("merges template values into field decorators", () => {
      const domain: DomainRecord = {
        id: "dom-1",
        name: "Finance",
        description: "",
        policyTemplate: {
          classification: "SENSITIVE",
          retention: "7 years",
        },
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { decorators, inherited } = applyPolicyTemplate(domain, {});

      expect(decorators.classification).toEqual({ level: "SENSITIVE" });
      expect((decorators.policy as Record<string, unknown>)?.retention).toBe("7 years");
      expect(inherited).not.toBeNull();
      expect(inherited!.keys).toContain("classification");
      expect(inherited!.keys).toContain("retention");
      expect(inherited!.domainName).toBe("Finance");
    });

    it("does not override existing field values", () => {
      const domain: DomainRecord = {
        id: "dom-1",
        name: "Finance",
        description: "",
        policyTemplate: { classification: "SENSITIVE" },
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { decorators, inherited } = applyPolicyTemplate(domain, {
        classification: { level: "PII" },
      });

      expect((decorators.classification as Record<string, unknown>)?.level).toBe("PII");
      expect(inherited).toBeNull(); // no keys were inherited
    });

    it("returns original decorators when no template exists", () => {
      const domain: DomainRecord = {
        id: "dom-1",
        name: "General",
        description: "",
        policyTemplate: null,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { decorators, inherited } = applyPolicyTemplate(domain, { custom: "value" });

      expect(decorators).toEqual({ custom: "value" });
      expect(inherited).toBeNull();
    });

    it("sets _inherited metadata correctly", () => {
      const domain: DomainRecord = {
        id: "dom-1",
        name: "Finance",
        description: "",
        policyTemplate: { classification: "PII", retention: "3 years" },
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { decorators } = applyPolicyTemplate(domain, {});
      const inherited = decorators._inherited as { domainId: string; keys: string[] };

      expect(inherited.domainId).toBe("dom-1");
      expect(inherited.keys).toContain("classification");
      expect(inherited.keys).toContain("retention");
    });
  });

  describe("removeInheritance", () => {
    it("removes a key from inherited metadata", () => {
      const decorators = {
        classification: { level: "PII" },
        _inherited: {
          domainId: "dom-1",
          domainName: "Finance",
          keys: ["classification", "retention"],
        },
      };

      const result = removeInheritance(decorators, "classification");
      const inherited = result._inherited as { keys: string[] };
      expect(inherited.keys).toEqual(["retention"]);
    });

    it("removes _inherited entirely when no keys remain", () => {
      const decorators = {
        classification: { level: "PII" },
        _inherited: {
          domainId: "dom-1",
          domainName: "Finance",
          keys: ["classification"],
        },
      };

      const result = removeInheritance(decorators, "classification");
      expect(result._inherited).toBeUndefined();
    });

    it("returns unchanged decorators when no _inherited exists", () => {
      const decorators = { classification: { level: "PII" } };
      const result = removeInheritance(decorators, "classification");
      expect(result).toEqual(decorators);
    });
  });
});
