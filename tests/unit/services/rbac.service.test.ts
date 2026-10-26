import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory store for the Prisma mock
// ---------------------------------------------------------------------------
let roleStore: Array<{
  id: string;
  userId: string;
  role: string;
  scopeKey: string;
  tenantId: string | null;
  domainId: string | null;
  productId?: string | null;
  grantedById: string | null;
  createdAt: Date;
}> = [];
let idCounter = 0;
/** Users the mock database knows as disabled (`disabledAt` set). */
const disabledUsers = new Set<string>();
/** The audit rows written (through the transaction's own client: the entry commits or rolls back with the change it describes). */
let auditStore: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        auditStore.push(args.data);
        return { id: `audit-${auditStore.length}`, ...args.data };
      }),
    },
    userRole: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        if (args?.where?.userId) {
          return roleStore.filter((r) => r.userId === args.where!.userId);
        }
        return [...roleStore];
      }),
      findFirst: vi.fn(
        async (args: { where: { userId: string; role: string; scopeKey: string } }) => {
          return (
            roleStore.find(
              (r) =>
                r.userId === args.where.userId &&
                r.role === args.where.role &&
                r.scopeKey === args.where.scopeKey
            ) ?? null
          );
        }
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return roleStore.find((r) => r.id === args.where.id) ?? null;
      }),
      create: vi.fn(
        async (args: {
          data: { userId: string; role: string; scopeKey: string; tenantId: string | null; domainId: string | null; productId?: string | null; grantedById: string | null };
        }) => {
          const row = {
            id: `role-${++idCounter}`,
            userId: args.data.userId,
            role: args.data.role,
            scopeKey: args.data.scopeKey,
            tenantId: args.data.tenantId,
            domainId: args.data.domainId,
            productId: args.data.productId ?? null,
            grantedById: args.data.grantedById,
            createdAt: new Date(),
          };
          roleStore.push(row);
          return row;
        }
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const idx = roleStore.findIndex((r) => r.id === args.where.id);
        if (idx !== -1) roleStore.splice(idx, 1);
      }),
      deleteMany: vi.fn(async () => {
        roleStore = [];
        idCounter = 0;
      }),
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const where = (args?.where ?? {}) as { role?: string; scopeKey?: string; id?: { not?: string }; user?: { disabledAt?: null } };
        return roleStore.filter(
          (r) =>
            (where.role === undefined || r.role === where.role) &&
            (where.scopeKey === undefined || r.scopeKey === where.scopeKey) &&
            (where.id?.not === undefined || r.id !== where.id.not) &&
            (where.user?.disabledAt === undefined || !disabledUsers.has(r.userId))
        ).length;
      }),
    },
    // The users that exist: every id but "ghost-user" (a role row has a foreign key to its user: an id that is nobody's used to throw P2003).
    // Read with its roles (the granter's assignments) and `disabledAt`, as the service selects them.
    user: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id === "ghost-user"
          ? null
          : { id: args.where.id, disabledAt: disabledUsers.has(args.where.id) ? new Date() : null, roles: roleStore.filter((r) => r.userId === args.where.id) }
      ),
    },
    // The tenants that exist: the ones whose id starts with "tenant-".
    tenant: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => (args.where.id.startsWith("tenant-") ? { id: args.where.id } : null)),
    },
    // The domains that exist: the ones whose id starts with "dom-" (a role row has a foreign key to its domain), all in tenant "tenant-a"
    // except the ones named "dom-b-*", which are tenant "tenant-b"'s.
    domain: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id.startsWith("dom-") ? { id: args.where.id, tenantId: args.where.id.startsWith("dom-b-") ? "tenant-b" : "tenant-a" } : null
      ),
    },
    // The products that exist: the ones whose id starts with "prod-", all in domain "dom-1" of tenant "tenant-a".
    product: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id.startsWith("prod-") ? { id: args.where.id, domainId: "dom-1", domain: { tenantId: "tenant-a" } } : null
      ),
    },
    // A transaction runs the callback against the same in-memory database (serializable isolation is the database's job; see the PGlite test).
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn((await import("@/lib/db")).prisma)),
  },
}));

import {
  getUserRoles,
  assignRole,
  removeRole,
  getEffectiveRole,
  hasPermission,
  _resetRoleStore,
  _getRoleStore,
} from "@/services/rbac.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  prisma: null as unknown as ServiceContext["prisma"],
};

const authorCtx: ServiceContext = {
  userId: "author-1",
  userRole: "AUTHOR",
  prisma: null as unknown as ServiceContext["prisma"],
};

/** A stored role row for a user: the granter's authority is what is in this table, never the label of the context. */
function seedRole(userId: string, role: string, scope: { key: string; tenantId?: string | null; domainId?: string | null; productId?: string | null }) {
  const row = {
    id: `seed-${userId}-${role}-${scope.key}`,
    userId,
    role,
    scopeKey: scope.key,
    tenantId: scope.tenantId ?? null,
    domainId: scope.domainId ?? null,
    productId: scope.productId ?? null,
    grantedById: null,
    createdAt: new Date(),
  };
  roleStore.push(row);
  return row;
}
const seedGlobalAdmin = (userId: string) => seedRole(userId, "ADMIN", { key: "G" });
const seedTenantAdmin = (userId: string, tenantId = "tenant-a") => seedRole(userId, "ADMIN", { key: `T:${tenantId}`, tenantId });

const ctxOf = (userId: string, userRole = "VIEWER"): ServiceContext => ({ userId, userRole, prisma: null as unknown as ServiceContext["prisma"] });
/** The roles in the store other than the seeded caller's own. */
const grantedRows = async () => (await _getRoleStore()).filter((r) => r.userId !== "admin-1");
/** The same, as the raw stored rows (scope key, tenant, product, granter). */
const storedRows = async () => ((await prisma.userRole.findMany()) as unknown as Array<Record<string, unknown>>).filter((r) => r.userId !== "admin-1");

describe("RBAC Service", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await _resetRoleStore();
    disabledUsers.clear();
    auditStore = [];
    // `admin-1` is a stored global ADMIN: the caller of most tests below. (Before, the context's label said so; now only stored rows count.)
    seedGlobalAdmin("admin-1");
  });

  describe("assignRole", () => {
    it("assigns a domain-scoped VIEWER role", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe("VIEWER");
        expect(result.data.domainId).toBe("dom-1");
      }
    });

    it("refuses a domain that does not exist, with a message, and writes nothing", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "no-such-domain" },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
        expect(result.error.message).toBe('Domain "no-such-domain" not found');
      }
      expect(await grantedRows()).toEqual([]);
    });

    it("refuses a user that does not exist, with a message, and writes nothing (the foreign key used to throw P2003 out of the action)", async () => {
      for (const input of [
        { userId: "ghost-user", role: "VIEWER" as const, domainId: "dom-1" },
        { userId: "ghost-user", role: "ADMIN" as const },
      ]) {
        const result = await assignRole(input, adminCtx);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("NOT_FOUND");
          expect(result.error.message).toBe('User "ghost-user" not found');
          expect(result.error.suggestedFix).toMatch(/existing user/i);
        }
      }
      expect(await grantedRows()).toEqual([]);
    });

    it("assigns a domain-scoped AUTHOR role", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe("AUTHOR");
      }
    });

    it("assigns a domain-scoped STEWARD role", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "STEWARD", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(true);
    });

    it("assigns system-level ADMIN role", async () => {
      const result = await assignRole(
        { userId: "user-2", role: "ADMIN" },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe("ADMIN");
        expect(result.data.domainId).toBeNull();
      }
    });

    it("refuses a platform-wide COMPLIANCE_OFFICER, STEWARD, AUTHOR or VIEWER (GLOBAL is valid for ADMIN only), says why, and writes nothing", async () => {
      for (const role of ["COMPLIANCE_OFFICER", "STEWARD", "AUTHOR", "VIEWER"] as const) {
        const result = await assignRole({ userId: "user-3", role }, adminCtx);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("VALIDATION_ERROR");
          expect(result.error.message).toContain("only ADMIN can");
          expect(result.error.suggestedFix).toMatch(/tenant, a domain or a product/);
        }
      }
      expect(await grantedRows()).toEqual([]);
    });

    it("assigns COMPLIANCE_OFFICER and ADMIN at TENANT scope (any role at any scope except GLOBAL), the tenant being checked to exist", async () => {
      for (const role of ["COMPLIANCE_OFFICER", "ADMIN"] as const) {
        const result = await assignRole({ userId: "user-1", role, tenantId: "tenant-a" }, adminCtx);
        expect(result.success).toBe(true);
      }
      expect((await storedRows()).map((row) => [row.role, row.scopeKey, row.tenantId, row.domainId])).toEqual([
        ["COMPLIANCE_OFFICER", "T:tenant-a", "tenant-a", null],
        ["ADMIN", "T:tenant-a", "tenant-a", null],
      ]);
      const missing = await assignRole({ userId: "user-1", role: "AUTHOR", tenantId: "nope" }, adminCtx);
      expect(missing).toMatchObject({ success: false, error: { code: "NOT_FOUND", message: 'Tenant "nope" not found' } });
    });

    it("assigns ADMIN and COMPLIANCE_OFFICER at DOMAIN scope too, and any role at PRODUCT scope with the product's own domain and tenant", async () => {
      expect((await assignRole({ userId: "user-1", role: "ADMIN", domainId: "dom-1" }, adminCtx)).success).toBe(true);
      expect((await assignRole({ userId: "user-1", role: "COMPLIANCE_OFFICER", domainId: "dom-1" }, adminCtx)).success).toBe(true);
      expect((await assignRole({ userId: "user-1", role: "AUTHOR", productId: "prod-1" }, adminCtx)).success).toBe(true);
      expect((await storedRows()).map((row) => [row.role, row.scopeKey, row.tenantId, row.domainId, row.productId])).toEqual([
        ["ADMIN", "D:dom-1", "tenant-a", "dom-1", null],
        ["COMPLIANCE_OFFICER", "D:dom-1", "tenant-a", "dom-1", null],
        ["AUTHOR", "P:prod-1", "tenant-a", "dom-1", "prod-1"],
      ]);
    });

    it("takes the tenant and domain of a role from the stored rows, never the caller's word: ids that disagree name nothing", async () => {
      for (const input of [
        { userId: "user-1", role: "AUTHOR" as const, domainId: "dom-1", tenantId: "tenant-b" },
        { userId: "user-1", role: "AUTHOR" as const, productId: "prod-1", domainId: "dom-2" },
        { userId: "user-1", role: "AUTHOR" as const, productId: "prod-1", tenantId: "tenant-b" },
      ]) {
        const result = await assignRole(input, adminCtx);
        expect(result.success).toBe(false);
      }
      expect(await grantedRows()).toEqual([]);
    });

    it("rejects duplicate role assignment", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      const result = await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
      }
    });

    it("rejects a caller who holds no role, with one generic message and no look-up of the target", async () => {
      const result = await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, authorCtx);
      expect(result).toEqual({
        success: false,
        error: { code: "FORBIDDEN", message: "You do not have permission to do this", suggestedFix: "Contact your administrator" },
      });
      expect(prisma.domain.findUnique).not.toHaveBeenCalled();
    });

    it("ignores the label of the context: an ADMIN label over stored roles that grant nothing (or no stored roles) is refused", async () => {
      seedRole("liar-1", "AUTHOR", { key: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1" });
      for (const userId of ["liar-1", "never-heard-of-1"]) {
        const result = await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, ctxOf(userId, "ADMIN"));
        expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
      }
      expect(await grantedRows()).toHaveLength(1);
    });

    it("refuses a disabled granter and a granter who does not exist", async () => {
      seedGlobalAdmin("ex-admin");
      disabledUsers.add("ex-admin");
      for (const userId of ["ex-admin", "ghost-user"]) {
        expect(await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, ctxOf(userId))).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
      }
    });

    describe("who may grant where (grantAllowed)", () => {
      it("a tenant ADMIN grants inside their tenant (its domains and products too) and nowhere else, and never GLOBAL", async () => {
        seedTenantAdmin("tadmin-a", "tenant-a");
        const as = ctxOf("tadmin-a");
        expect((await assignRole({ userId: "user-1", role: "ADMIN", tenantId: "tenant-a" }, as)).success).toBe(true);
        expect((await assignRole({ userId: "user-1", role: "STEWARD", domainId: "dom-1" }, as)).success).toBe(true);
        expect((await assignRole({ userId: "user-1", role: "VIEWER", productId: "prod-1" }, as)).success).toBe(true);

        const foreign = await assignRole({ userId: "user-1", role: "VIEWER", tenantId: "tenant-b" }, as);
        const foreignDomain = await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-b-1" }, as);
        const missingDomain = await assignRole({ userId: "user-1", role: "VIEWER", domainId: "no-such-domain" }, as);
        const global = await assignRole({ userId: "user-1", role: "ADMIN" }, as);
        for (const refused of [foreign, foreignDomain, global]) expect(refused).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
        // An id of another tenant and an id that is nobody's are the same answer to someone who is not a platform administrator.
        expect(JSON.stringify(missingDomain)).toBe(JSON.stringify(foreignDomain));
      });

      it("a domain ADMIN grants in their domain and its products, not in a sibling domain and not at tenant scope", async () => {
        seedRole("dadmin", "ADMIN", { key: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1" });
        const as = ctxOf("dadmin");
        expect((await assignRole({ userId: "user-1", role: "AUTHOR", domainId: "dom-1" }, as)).success).toBe(true);
        expect((await assignRole({ userId: "user-1", role: "AUTHOR", productId: "prod-1" }, as)).success).toBe(true);
        expect(await assignRole({ userId: "user-1", role: "AUTHOR", domainId: "dom-2" }, as)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
        expect(await assignRole({ userId: "user-1", role: "AUTHOR", tenantId: "tenant-a" }, as)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
      });

      it("a STEWARD, a COMPLIANCE_OFFICER and an AUTHOR grant nothing anywhere (only an ADMIN grants), their tenant included", async () => {
        for (const role of ["STEWARD", "COMPLIANCE_OFFICER", "AUTHOR", "VIEWER"]) {
          const userId = `holder-${role}`;
          seedRole(userId, role, { key: "T:tenant-a", tenantId: "tenant-a" });
          for (const input of [{ domainId: "dom-1" }, { tenantId: "tenant-a" }, { productId: "prod-1" }]) {
            const result = await assignRole({ userId: "user-1", role: "VIEWER", ...input }, ctxOf(userId));
            expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
          }
        }
        expect(await grantedRows()).toHaveLength(4);
      });

      it("a global ADMIN grants everywhere, and is told when the target does not exist", async () => {
        expect((await assignRole({ userId: "user-1", role: "ADMIN", tenantId: "tenant-b" }, adminCtx)).success).toBe(true);
        expect(await assignRole({ userId: "user-1", role: "VIEWER", productId: "no-such-product" }, adminCtx)).toMatchObject({
          success: false,
          error: { code: "NOT_FOUND", message: 'Product "no-such-product" not found' },
        });
      });
    });

    it("runs in a SERIALIZABLE transaction", async () => {
      await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    });
  });

  describe("removeRole", () => {
    it("removes a role assignment", async () => {
      const assigned = await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      expect(assigned.success).toBe(true);
      if (!assigned.success) return;

      const result = await removeRole(assigned.data.id, adminCtx);
      expect(result.success).toBe(true);
      expect(await grantedRows()).toHaveLength(0);
    });

    it("an administrator cannot remove their own administrator assignment, at platform scope or at any other", async () => {
      const tenantAdmin = seedTenantAdmin("tadmin-a");
      const own = await removeRole(tenantAdmin.id, ctxOf("tadmin-a"));
      expect(own).toMatchObject({ success: false, error: { code: "FORBIDDEN", message: "Cannot remove your own admin role" } });

      const domainAdmin = seedRole("dadmin", "ADMIN", { key: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1" });
      expect(await removeRole(domainAdmin.id, ctxOf("dadmin"))).toMatchObject({ success: false, error: { message: "Cannot remove your own admin role" } });

      const globalAdmin = seedGlobalAdmin("admin-2");
      const second = await removeRole(globalAdmin.id, ctxOf("admin-2"));
      expect(second).toMatchObject({ success: false, error: { message: "Cannot remove your own admin role" } });
      expect(await grantedRows()).toHaveLength(3);
    });

    it("an administrator may remove their own non-administrator assignments (the rule is about the administrator role)", async () => {
      const own = seedRole("admin-1", "AUTHOR", { key: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1" });
      expect((await removeRole(own.id, adminCtx)).success).toBe(true);
    });

    it("never removes the last ENABLED global administrator: the guard asks the database whether another one remains (belt and braces behind the self-removal rule)", async () => {
      const other = seedGlobalAdmin("user-other");
      vi.mocked(prisma.userRole.count).mockResolvedValueOnce(0);
      const result = await removeRole(other.id, adminCtx);
      expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
      if (!result.success) expect(result.error.message).toContain("at least one admin");
      expect(await grantedRows()).toHaveLength(1);
      // The question names the enabled global administrators other than this row.
      expect(prisma.userRole.count).toHaveBeenLastCalledWith({ where: { role: "ADMIN", scopeKey: "G", id: { not: other.id }, user: { disabledAt: null } } });
    });

    it("can remove a global administrator when another one remains", async () => {
      const second = seedGlobalAdmin("admin-2");
      expect((await removeRole(second.id, adminCtx)).success).toBe(true);
    });

    it("a DISABLED administrator does not count as one that remains", async () => {
      seedGlobalAdmin("admin-2");
      disabledUsers.add("admin-2");
      const third = seedGlobalAdmin("admin-3");
      disabledUsers.add("admin-1"); // the caller is disabled: nobody grants anything
      expect(await removeRole(third.id, adminCtx)).toMatchObject({ success: false, error: { code: "FORBIDDEN", message: "You do not have permission to do this" } });
    });

    it("rejects a caller who holds no role", async () => {
      const result = await removeRole("some-id", authorCtx);
      expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN", message: "You do not have permission to do this" } });
    });

    it("ignores the label of the context", async () => {
      const row = seedRole("someone", "VIEWER", { key: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1" });
      expect(await removeRole(row.id, ctxOf("liar-1", "ADMIN"))).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
      expect(await grantedRows()).toHaveLength(1);
    });

    it("a tenant ADMIN removes roles inside their tenant; a role of another tenant, a platform role and a missing one are the SAME not-found", async () => {
      seedTenantAdmin("tadmin-a", "tenant-a");
      const as = ctxOf("tadmin-a");
      const mine = seedRole("user-1", "AUTHOR", { key: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1" });
      const theirs = seedRole("user-1", "AUTHOR", { key: "D:dom-b-1", tenantId: "tenant-b", domainId: "dom-b-1" });
      const platform = seedGlobalAdmin("admin-2");

      const outside = await removeRole(theirs.id, as);
      const above = await removeRole(platform.id, as);
      const missing = await removeRole("no-such-role", as);
      expect(outside).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Role assignment not found", suggestedFix: "Verify the role assignment ID." } });
      expect(JSON.stringify(above)).toBe(JSON.stringify(outside));
      expect(JSON.stringify(missing)).toBe(JSON.stringify(outside));
      expect((await removeRole(mine.id, as)).success).toBe(true);
      const left = (await grantedRows()).map((row) => row.id);
      expect(left).toContain(theirs.id);
      expect(left).toContain(platform.id);
      expect(left).not.toContain(mine.id);
    });

    it("a platform administrator can clear a row that is not a valid assignment (a legacy row), nobody else can", async () => {
      const junk = seedRole("user-1", "COMPLIANCE_OFFICER", { key: "G" });
      seedTenantAdmin("tadmin-a", "tenant-a");
      expect(await removeRole(junk.id, ctxOf("tadmin-a"))).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
      expect((await removeRole(junk.id, adminCtx)).success).toBe(true);
    });

    it("runs in a SERIALIZABLE transaction", async () => {
      const row = seedRole("user-1", "VIEWER", { key: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1" });
      await removeRole(row.id, adminCtx);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    });
  });

  describe("getEffectiveRole", () => {
    it("returns null when user has no roles", async () => {
      const result = await getEffectiveRole("user-1", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it("returns domain-scoped role for matching domain", async () => {
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      const result = await getEffectiveRole("user-1", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("AUTHOR");
      }
    });

    it("domain-scoped role does NOT apply to different domain", async () => {
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      const result = await getEffectiveRole("user-1", "dom-2", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it("system-level roles apply globally (any domain)", async () => {
      await assignRole({ userId: "user-1", role: "ADMIN" }, adminCtx);
      const result = await getEffectiveRole("user-1", "dom-999", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("ADMIN");
      }
    });

    it("returns the most permissive role when user has multiple", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      await assignRole(
        { userId: "user-1", role: "STEWARD", domainId: "dom-1" },
        adminCtx
      );
      const result = await getEffectiveRole("user-1", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("STEWARD");
      }
    });

    it("system ADMIN overrides domain VIEWER", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      await assignRole({ userId: "user-1", role: "ADMIN" }, adminCtx);
      const result = await getEffectiveRole("user-1", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("ADMIN");
      }
    });
  });

  describe("hasPermission", () => {
    it("returns true when user has sufficient role", async () => {
      await assignRole(
        { userId: "user-1", role: "STEWARD", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(true);
      }
    });

    it("returns false when user has insufficient role", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(false);
      }
    });

    it("returns false when user has no roles", async () => {
      const result = await hasPermission("user-1", "VIEWER", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(false);
      }
    });

    it("Viewer can read (has VIEWER permission)", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "VIEWER", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(true);
    });

    it("Viewer cannot create (lacks AUTHOR permission)", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(false);
    });

    it("Author can create in their domain", async () => {
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(true);
    });

    it("Author cannot create in different domain", async () => {
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-2", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(false);
    });

    it("Admin has all permissions globally", async () => {
      await assignRole({ userId: "user-1", role: "ADMIN" }, adminCtx);
      const result = await hasPermission("user-1", "ADMIN", "any-domain", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(true);
    });
  });

  describe("scope keys (the user_roles unique key since the access_control migration)", () => {
    it("writes the global key for a system-level role and the domain key, its tenant and the granter for a domain-scoped one", async () => {
      await assignRole({ userId: "user-1", role: "ADMIN" }, adminCtx);
      await assignRole({ userId: "user-1", role: "AUTHOR", domainId: "dom-1" }, adminCtx);

      const pick = (row: Record<string, unknown>) =>
        Object.fromEntries(["userId", "role", "scopeKey", "tenantId", "domainId", "productId", "grantedById"].map((key) => [key, row[key]]));
      expect((await storedRows()).map(pick)).toEqual([
        { userId: "user-1", role: "ADMIN", scopeKey: "G", tenantId: null, domainId: null, productId: null, grantedById: "admin-1" },
        { userId: "user-1", role: "AUTHOR", scopeKey: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1", productId: null, grantedById: "admin-1" },
      ]);
    });

    it("no longer has a way to make a user the administrator because none exists (the first administrator is the seed's or admin:create's)", async () => {
      expect(await import("@/services/rbac.service")).not.toHaveProperty("bootstrapFirstAdmin");
      expect(await grantedRows()).toEqual([]);
    });

    it("is the policy engine's reading: a tenant-scoped row applies to a domain of that tenant, a product-scoped row does not reach the domain above it", async () => {
      roleStore.push(
        { id: "t", userId: "user-1", role: "AUTHOR", scopeKey: "T:tenant-a", tenantId: "tenant-a", domainId: null, grantedById: null, createdAt: new Date() },
        { id: "p", userId: "user-1", role: "STEWARD", scopeKey: "P:prod-1", tenantId: "tenant-a", domainId: "dom-1", grantedById: null, createdAt: new Date() }
      );
      // dom-1 is a domain of tenant-a: the tenant AUTHOR row applies; the product STEWARD row covers its product only.
      expect(await getEffectiveRole("user-1", "dom-1", adminCtx)).toEqual({ success: true, data: "AUTHOR" });
      // Asked about no domain, only the platform (global) role counts: neither row is one.
      expect(await getEffectiveRole("user-1", null, adminCtx)).toEqual({ success: true, data: null });
    });

    it("a tenant-scoped row of ANOTHER tenant does not apply (nothing crosses tenants)", async () => {
      roleStore.push(
        { id: "t", userId: "user-1", role: "ADMIN", scopeKey: "T:tenant-b", tenantId: "tenant-b", domainId: null, grantedById: null, createdAt: new Date() }
      );
      expect(await getEffectiveRole("user-1", "dom-1", adminCtx)).toEqual({ success: true, data: null });
    });

    it("never counts a global row of a role other than ADMIN, nor a row whose key and columns disagree (the policy skips what is not a valid assignment)", async () => {
      roleStore.push(
        { id: "g", userId: "user-1", role: "AUTHOR", scopeKey: "G", tenantId: null, domainId: null, grantedById: null, createdAt: new Date() },
        { id: "x", userId: "user-1", role: "ADMIN", scopeKey: "D:dom-1", tenantId: "tenant-a", domainId: "dom-2", grantedById: null, createdAt: new Date() }
      );
      expect(await getEffectiveRole("user-1", "dom-1", adminCtx)).toEqual({ success: true, data: null });
      expect(await getEffectiveRole("user-1", null, adminCtx)).toEqual({ success: true, data: null });
    });

    it("reads the roles of an ACTIVE user only (the query excludes a disabled user's rows)", async () => {
      await getEffectiveRole("user-1", null, adminCtx);
      expect(prisma.userRole.findMany).toHaveBeenLastCalledWith({ where: { userId: "user-1", user: { disabledAt: null } } });
    });

    it("hasPermission follows it: a tenant AUTHOR may author in a domain of the tenant and not steward there", async () => {
      roleStore.push({ id: "t", userId: "user-1", role: "AUTHOR", scopeKey: "T:tenant-a", tenantId: "tenant-a", domainId: null, grantedById: null, createdAt: new Date() });
      expect(await hasPermission("user-1", "AUTHOR", "dom-1", adminCtx)).toEqual({ success: true, data: true });
      expect(await hasPermission("user-1", "STEWARD", "dom-1", adminCtx)).toEqual({ success: true, data: false });
    });

    it("removing a tenant-scoped ADMIN row does not consult the last-global-admin rule (only a platform row does)", async () => {
      roleStore.push(
        { id: "t", userId: "someone", role: "ADMIN", scopeKey: "T:tenant-a", tenantId: "tenant-a", domainId: null, grantedById: null, createdAt: new Date() }
      );
      vi.mocked(prisma.userRole.count).mockResolvedValueOnce(0);
      expect((await removeRole("t", adminCtx)).success).toBe(true);
      expect(prisma.userRole.count).not.toHaveBeenCalled();
    });
  });

  describe("getUserRoles", () => {
    it("returns all roles for a user", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-2" },
        adminCtx
      );

      const result = await getUserRoles("user-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
      }
    });

    it("returns empty array for user with no roles", async () => {
      const result = await getUserRoles("nobody", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });
  });

  describe("every grant and revoke is audited (KD-035)", () => {
    it("a grant writes ONE entry: who granted, whom, which role at which scope, the roles of the user before and after", async () => {
      seedRole("user-1", "VIEWER", { key: "T:tenant-a", tenantId: "tenant-a" });
      const result = await assignRole({ userId: "user-1", role: "AUTHOR", domainId: "dom-1" }, adminCtx);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(auditStore).toHaveLength(1);
      expect(auditStore[0]).toMatchObject({
        action: "ROLE_ASSIGNED",
        entityType: "User",
        entityId: "user-1",
        userId: "admin-1",
        tenantId: "tenant-a",
        beforeState: { roles: [{ role: "VIEWER", scopeKey: "T:tenant-a" }] },
        afterState: {
          roleId: result.data.id,
          role: "AUTHOR",
          scopeKey: "D:dom-1",
          roles: [
            { role: "VIEWER", scopeKey: "T:tenant-a" },
            { role: "AUTHOR", scopeKey: "D:dom-1" },
          ],
        },
      });
    });

    it("a platform grant is a platform-level entry (no tenant); a tenant and a product grant carry their tenant", async () => {
      await assignRole({ userId: "user-1", role: "ADMIN" }, adminCtx);
      await assignRole({ userId: "user-1", role: "VIEWER", tenantId: "tenant-a" }, adminCtx);
      await assignRole({ userId: "user-1", role: "AUTHOR", productId: "prod-1" }, adminCtx);
      expect(auditStore.map((e) => [e.action, e.tenantId])).toEqual([
        ["ROLE_ASSIGNED", null],
        ["ROLE_ASSIGNED", "tenant-a"],
        ["ROLE_ASSIGNED", "tenant-a"],
      ]);
    });

    it("a revoke writes ONE entry about the user who lost the role: the role as it was, the roles before and after", async () => {
      seedRole("user-1", "VIEWER", { key: "T:tenant-a", tenantId: "tenant-a" });
      const row = seedRole("user-1", "AUTHOR", { key: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1" });
      const result = await removeRole(row.id, adminCtx);
      expect(result.success).toBe(true);
      expect(auditStore).toHaveLength(1);
      expect(auditStore[0]).toMatchObject({
        action: "ROLE_REMOVED",
        entityType: "User",
        entityId: "user-1",
        userId: "admin-1",
        tenantId: "tenant-a",
        beforeState: {
          roleId: row.id,
          role: "AUTHOR",
          scopeKey: "D:dom-1",
          roles: [
            { role: "VIEWER", scopeKey: "T:tenant-a" },
            { role: "AUTHOR", scopeKey: "D:dom-1" },
          ],
        },
        afterState: { roles: [{ role: "VIEWER", scopeKey: "T:tenant-a" }] },
      });
    });

    it("writes nothing for a refusal: no authority, an invalid assignment, a duplicate, an unknown target, a last administrator, your own role", async () => {
      await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, authorCtx); // no authority
      await assignRole({ userId: "user-1", role: "AUTHOR" }, adminCtx); // GLOBAL is for ADMIN only
      await assignRole({ userId: "ghost-user", role: "VIEWER", domainId: "dom-1" }, adminCtx); // no such user
      await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-missing" }, adminCtx); // no such domain
      await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx);
      auditStore = [];
      await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx); // duplicate
      const own = seedTenantAdmin("tadmin-a");
      await removeRole(own.id, ctxOf("tadmin-a")); // own administrator role
      vi.mocked(prisma.userRole.count).mockResolvedValueOnce(0);
      await removeRole(seedGlobalAdmin("other-admin").id, adminCtx); // the last global administrator
      await removeRole("no-such-row", adminCtx);
      expect(auditStore).toEqual([]);
    });

    it("the entry is written through the transaction's client, after the change it describes, so both commit or neither does", async () => {
      const order: string[] = [];
      vi.mocked(prisma.userRole.create).mockImplementationOnce((async (args: { data: object }) => {
        order.push("role");
        return { id: "role-x", ...args.data, createdAt: new Date() };
      }) as never);
      vi.mocked(prisma.auditLog.create).mockImplementationOnce((async () => {
        order.push("audit");
        return { id: "audit-x" };
      }) as never);
      await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx);
      expect(order).toEqual(["role", "audit"]);
    });

    it("a failed audit write fails the whole change (answered, not thrown): no grant without its entry", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(new Error("disk full") as never);
      const result = await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx);
      expect(result).toMatchObject({ success: false, error: { code: "INTERNAL_ERROR" } });
    });
  });

  describe("failures of the database are answers, never exceptions out of a service", () => {
    it("a grant that loses the race for the unique key is a DUPLICATE answer (P2002), not a crash", async () => {
      vi.mocked(prisma.userRole.create).mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }) as never);
      const result = await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx);
      expect(result).toMatchObject({ success: false, error: { code: "DUPLICATE" } });
      expect(auditStore).toEqual([]);
    });

    it("a user or scope deleted between the look-up and the insert is a NOT_FOUND answer (P2003), not a crash", async () => {
      vi.mocked(prisma.userRole.create).mockRejectedValueOnce(Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" }) as never);
      const result = await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx);
      expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    });

    it("anything else is a generic INTERNAL_ERROR (logged), for a grant and for a revoke", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(prisma.userRole.create).mockRejectedValueOnce(new Error("connection reset") as never);
      expect(await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx)).toMatchObject({ success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
      const row = seedRole("user-1", "VIEWER", { key: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1" });
      vi.mocked(prisma.userRole.delete).mockRejectedValueOnce(new Error("connection reset") as never);
      expect(await removeRole(row.id, adminCtx)).toMatchObject({ success: false, error: { code: "INTERNAL_ERROR" } });
    });

    it("a transaction that keeps losing the race to the end is a CONFLICT answer", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(prisma.$transaction).mockRejectedValue(Object.assign(new Error("write conflict"), { code: "P2034" }));
      const result = await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx);
      expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
      vi.mocked(prisma.$transaction).mockImplementation((async (fn: (tx: unknown) => unknown) => fn((await import("@/lib/db")).prisma)) as never);
    });

    it("a transaction that loses the race once is run again and the change is made (the faked P2034 retry)", async () => {
      let round = 0;
      const real = vi.mocked(prisma.$transaction).getMockImplementation()!;
      vi.mocked(prisma.$transaction).mockImplementation((async (fn: (tx: unknown) => unknown, options?: unknown) => {
        if (++round === 1) throw Object.assign(new Error("write conflict"), { code: "P2034" });
        return real(fn as never, options as never);
      }) as never);
      const result = await assignRole({ userId: "user-1", role: "VIEWER", domainId: "dom-1" }, adminCtx);
      expect(result.success).toBe(true);
      expect(round).toBe(2);
      expect(auditStore).toHaveLength(1); // the entry of the aborted round was never written
    });
  });

  it("revokeRole is the name the plan gives removeRole: the same function", async () => {
    const { revokeRole } = await import("@/services/rbac.service");
    expect(revokeRole).toBe(removeRole);
  });
});
