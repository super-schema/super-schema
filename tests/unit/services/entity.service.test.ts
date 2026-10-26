import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTx, mockAssertNameAvailable } = vi.hoisted(() => ({
  mockTx: {
    entity: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  mockAssertNameAvailable: vi.fn(),
}));

vi.mock("@/services/name-registry.service", () => ({
  assertNameAvailable: mockAssertNameAvailable,
  withTenantNameLock: (_db: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
}));

vi.mock("@/lib/db", () => {
  const prisma: Record<string, unknown> = {
    entity: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    product: {
      findUnique: vi.fn().mockResolvedValue({
        id: "prd-default",
        domainId: "dom-1",
        domain: { tenantId: "tenant-1" },
      }),
      create: vi.fn().mockResolvedValue({ id: "prd-default" }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
    trait: { findMany: vi.fn().mockResolvedValue([]) },
    entityVersion: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    schemaReference: { findMany: vi.fn().mockResolvedValue([]) },
    // Event documents pin entities without foreign keys: the event guard reads them (A9).
    eventSpec: { findMany: vi.fn().mockResolvedValue([]) },
    // The guarded delete locks the entity row (`SELECT ... FOR UPDATE`, answered with the id it was given) and runs in one transaction
    // (the callback gets this same client, so every delegate above is what the transaction reads and writes).
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, id: string) => [{ id }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma };
});

import {
  createEntity,
  getEntities,
  getEntityById,
  updateEntity,
  deleteEntity,
} from "@/services/entity.service";
import { prisma } from "@/lib/db";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import type { ServiceContext } from "@/types/service-context";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

const CONFLICT_ERROR = {
  code: "NAME_CONFLICT",
  message: '"Customer" is already used by Enum "Customer" at Domain level.',
  suggestedFix: "Choose a different name.",
};

describe("Entity Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
  });

  describe("createEntity", () => {
    it("returns success result on valid input", async () => {
      const mockEntity = {
        id: "ent-1",
        name: "Customer",
        domainId: "dom-1",
        version: 1,
        status: "DRAFT",
      };
      mockTx.entity.create.mockResolvedValue(mockEntity as never);

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "Customer entity" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Customer");
      }
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, {
        name: "Customer",
        tenantId: "tenant-1",
        domainId: "dom-1",
        productId: "prd-default",
      });
      expect(mockTx.entity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            domainId: "dom-1",
            tenantId: "tenant-1",
            productId: "prd-default",
          }),
        })
      );
    });

    it("returns the registry conflict, creates nothing and writes no audit log", async () => {
      mockAssertNameAvailable.mockResolvedValue({ success: false, error: CONFLICT_ERROR });

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "Clash" },
        mockCtx
      );

      expect(result).toEqual({ success: false, error: CONFLICT_ERROR });
      expect(mockTx.entity.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("returns NOT_FOUND when the domain's default product cannot be resolved", async () => {
      vi.mocked(prisma.product.findUnique)
        .mockResolvedValueOnce({ id: "prd-default" } as never) // ensureDefaultProductId
        .mockResolvedValueOnce(null); // resolveScope

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    });

    it("returns error for duplicate entity name in same domain", async () => {
      mockTx.entity.create.mockRejectedValue(
        new Error("Unique constraint failed on the constraint: `entities_name_domainId_key`")
      );

      const result = await createEntity(
        { name: "Customer", domainId: "dom-1", description: "Duplicate" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
        expect(result.error.suggestedFix).toContain("different name");
      }
    });

    it("returns error for invalid metadata JSONB", async () => {
      const result = await createEntity(
        {
          name: "Test",
          domainId: "dom-1",
          description: "Test",
          metadata: { relationships: [{ targetEntityId: "x", type: "invalid-type" }] } as never,
        },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.suggestedFix).toBeDefined();
      }
    });

    it.each(["url", "int32", "Duration", "String", "Object"])("rejects '%s' as an entity name (a built-in type name), creating nothing", async (name) => {
      const result = await createEntity({ name, domainId: "dom-1", description: "" }, mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain(`"${name}" is a built-in type name`);
        expect(result.error.message).toContain("choose another name");
      }
      expect(mockTx.entity.create).not.toHaveBeenCalled();
    });

    it("rejects 'Events' entity name (reserved for event spec routes)", async () => {
      const result = await createEntity(
        { name: "Events", domainId: "dom-1", description: "Reserved for event spec routes" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("reserved");
      }
      expect(mockTx.entity.create).not.toHaveBeenCalled();
    });
  });

  describe("getEntities", () => {
    it("returns filtered entity list", async () => {
      const mockEntities = [{ id: "ent-1", name: "Customer" }];
      vi.mocked(prisma.entity.findMany).mockResolvedValue(mockEntities as never);

      const result = await getEntities({ domainId: "dom-1" }, { ...mockCtx, assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }] });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });

    describe("with a tenant in the context (the page and action callers)", () => {
      const where = () => vi.mocked(prisma.entity.findMany).mock.calls[0][0]?.where;
      const inTenant = (assignments: ServiceContext["assignments"]): ServiceContext => ({ ...mockCtx, tenantId: "tenant-1", assignments });

      beforeEach(() => {
        vi.mocked(prisma.entity.findMany).mockResolvedValue([] as never);
      });

      it("reads only the tenant in view, all of its entities for a tenant-wide role", async () => {
        await getEntities({ domainId: "dom-1" }, inTenant([{ role: "VIEWER", scope: { kind: "TENANT", tenantId: "tenant-1" } }]));
        expect(where()).toEqual({ tenantId: "tenant-1", domainId: "dom-1" });
      });

      it("a platform administrator reads the tenant in view and no other", async () => {
        await getEntities({}, inTenant([{ role: "ADMIN", scope: { kind: "GLOBAL" } }]));
        expect(where()).toEqual({ tenantId: "tenant-1" });
      });

      it("a domain- or product-scoped role reads only the entities under its domains and products, in the query", async () => {
        await getEntities(
          {},
          inTenant([
            { role: "VIEWER", scope: { kind: "DOMAIN", tenantId: "tenant-1", domainId: "dom-a" } },
            { role: "AUTHOR", scope: { kind: "PRODUCT", tenantId: "tenant-1", domainId: "dom-b", productId: "prod-x" } },
            { role: "ADMIN", scope: { kind: "TENANT", tenantId: "tenant-2" } },
          ])
        );
        expect(where()).toEqual({ tenantId: "tenant-1", OR: [{ domainId: { in: ["dom-a"] } }, { productId: { in: ["prod-x"] } }] });
      });

      it("a caller with no assignment (or none in this tenant) reads nothing: an empty scope matches no entity", async () => {
        await getEntities({}, inTenant(undefined));
        expect(where()).toEqual({ tenantId: "tenant-1", OR: [{ domainId: { in: [] } }, { productId: { in: [] } }] });
      });
    });

    describe("with no tenant in the context (a caller that is not a page): only a platform administrator reads across tenants", () => {
      it("a platform administrator is not restricted", async () => {
        vi.mocked(prisma.entity.findMany).mockResolvedValue([] as never);
        await getEntities({}, { ...mockCtx, assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }] });
        expect(vi.mocked(prisma.entity.findMany).mock.calls.at(-1)?.[0]?.where).toEqual({});
      });

      it("anyone else is refused and nothing is read (a context that carries no tenant never means 'every tenant')", async () => {
        vi.mocked(prisma.entity.findMany).mockClear();
        for (const assignments of [undefined, [], [{ role: "ADMIN", scope: { kind: "TENANT", tenantId: "tenant-1" } }]] as const) {
          const result = await getEntities({}, { ...mockCtx, assignments: assignments as ServiceContext["assignments"] });
          expect(result).toEqual({ success: false, error: { code: "FORBIDDEN", message: "You do not have permission to do this" } });
        }
        expect(prisma.entity.findMany).not.toHaveBeenCalled();
      });
    });
  });

  describe("getEntityById (tenant-scoped, and by role: an entity the caller may not read is a missing one)", () => {
    const VIEWER_T1: ServiceContext["assignments"] = [{ role: "VIEWER", scope: { kind: "TENANT", tenantId: "tenant-1" } }];
    const ctxOf = (assignments: ServiceContext["assignments"], tenantId?: string): ServiceContext => ({ ...mockCtx, assignments, ...(tenantId ? { tenantId } : {}) });
    const row = (over: Record<string, unknown> = {}) => ({
      id: "ent-1", tenantId: "tenant-1", domainId: "dom-a", productId: "prod-1", name: "Customer", domain: { id: "dom-a" }, fields: [], product: { domainId: "dom-a" }, ...over,
    });
    const MISSING = { success: false, error: { code: "NOT_FOUND", message: 'Entity with ID "ent-1" not found', suggestedFix: "Verify the entity ID and try again." } };

    it("returns the entity (and only the entity: not the product it was placed through) to a role that covers it in the tenant in view", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(row() as never);
      const result = await getEntityById("ent-1", ctxOf(VIEWER_T1, "tenant-1"));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ id: "ent-1", name: "Customer" });
        expect(result.data).not.toHaveProperty("product");
      }
    });

    it("returns not-found for a missing entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);
      const result = await getEntityById("ent-1", ctxOf(VIEWER_T1, "tenant-1"));
      expect(result).toEqual(MISSING);
    });

    it("an entity of ANOTHER tenant than the one in view is the very answer of a missing one, whatever role the caller holds there", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(row({ tenantId: "tenant-2" }) as never);
      const both = [...VIEWER_T1!, { role: "ADMIN", scope: { kind: "TENANT", tenantId: "tenant-2" } }, { role: "ADMIN", scope: { kind: "GLOBAL" } }] as ServiceContext["assignments"];
      expect(await getEntityById("ent-1", ctxOf(both, "tenant-1"))).toEqual(MISSING);
    });

    it("a caller with no role over it (none at all, another tenant's, a sibling domain's) gets the same answer", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(row() as never);
      for (const assignments of [
        undefined,
        [],
        [{ role: "ADMIN", scope: { kind: "TENANT", tenantId: "tenant-2" } }],
        [{ role: "ADMIN", scope: { kind: "DOMAIN", tenantId: "tenant-1", domainId: "dom-b" } }],
        [{ role: "ADMIN", scope: { kind: "PRODUCT", tenantId: "tenant-1", domainId: "dom-a", productId: "prod-2" } }],
      ] as ServiceContext["assignments"][]) {
        expect(await getEntityById("ent-1", ctxOf(assignments, "tenant-1")), JSON.stringify(assignments)).toEqual(MISSING);
      }
    });

    it("a domain-scoped role reads the entities of its domain, and a product-level entity whose domain column is empty through its product's domain", async () => {
      const inDomain: ServiceContext["assignments"] = [{ role: "VIEWER", scope: { kind: "DOMAIN", tenantId: "tenant-1", domainId: "dom-a" } }];
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(row() as never);
      expect((await getEntityById("ent-1", ctxOf(inDomain, "tenant-1"))).success).toBe(true);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(row({ domainId: null }) as never);
      expect((await getEntityById("ent-1", ctxOf(inDomain, "tenant-1"))).success).toBe(true);
    });

    it("a tenant-level entity is read through a tenant or platform role only, never through a domain role", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(row({ domainId: null, productId: null, product: null }) as never);
      const inDomain: ServiceContext["assignments"] = [{ role: "ADMIN", scope: { kind: "DOMAIN", tenantId: "tenant-1", domainId: "dom-a" } }];
      expect(await getEntityById("ent-1", ctxOf(inDomain, "tenant-1"))).toEqual(MISSING);
      expect((await getEntityById("ent-1", ctxOf(VIEWER_T1, "tenant-1"))).success).toBe(true);
    });

    it("with no tenant in the context the caller's roles decide alone: a platform administrator reads any, a tenant role its own tenant only, nobody else", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(row() as never);
      expect((await getEntityById("ent-1", ctxOf([{ role: "ADMIN", scope: { kind: "GLOBAL" } }]))).success).toBe(true);
      expect((await getEntityById("ent-1", ctxOf(VIEWER_T1))).success).toBe(true);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(row({ tenantId: "tenant-2" }) as never);
      expect(await getEntityById("ent-1", ctxOf(VIEWER_T1))).toEqual(MISSING);
      expect(await getEntityById("ent-1", ctxOf(undefined))).toEqual(MISSING);
    });
  });

  describe("updateEntity", () => {
    const existing = {
      id: "ent-1",
      name: "Customer",
      version: 1,
      tenantId: "tenant-1",
      domainId: "dom-1",
      productId: "prd-1",
      status: "DRAFT",
    };

    it.each(["url", "int32", "String"])("rejects renaming to '%s' (a built-in type name)", async (name) => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);

      const result = await updateEntity("ent-1", { name }, mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain(`"${name}" is a built-in type name`);
      }
      expect(mockTx.entity.update).not.toHaveBeenCalled();
    });

    it("an entity that ALREADY has a built-in name can still be edited (only a change of the name is refused)", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, name: "url" } as never);
      mockTx.entity.update.mockResolvedValue({ ...existing, name: "url", description: "x" } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, name: "url", description: "x" } as never);

      const result = await updateEntity("ent-1", { name: "url", description: "x" }, mockCtx);

      expect(result.success).toBe(true);
    });

    it("rejects renaming to 'Specs' (reserved URL segment)", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);

      const result = await updateEntity("ent-1", { name: "Specs" }, mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("reserved");
      }
      expect(mockTx.entity.update).not.toHaveBeenCalled();
    });

    it("renames through the registry (excluding the entity itself) inside the tenant lock", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      mockTx.entity.update.mockResolvedValue({ ...existing, name: "CustomerV2" } as never);

      const result = await updateEntity("ent-1", { name: "CustomerV2" }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("CustomerV2");
      }
      expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, {
        name: "CustomerV2",
        tenantId: "tenant-1",
        domainId: "dom-1",
        productId: "prd-1",
        exclude: { kind: "entity", id: "ent-1" },
      });
      expect(mockTx.entity.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ent-1" }, data: expect.objectContaining({ name: "CustomerV2" }) })
      );
      expect(prisma.entity.update).not.toHaveBeenCalled();
    });

    it("returns the registry conflict and does not rename", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      mockAssertNameAvailable.mockResolvedValue({ success: false, error: CONFLICT_ERROR });

      const result = await updateEntity("ent-1", { name: "Order" }, mockCtx);

      expect(result).toEqual({ success: false, error: CONFLICT_ERROR });
      expect(mockTx.entity.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("skips the registry when the name is unchanged", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, description: "d" } as never);

      const result = await updateEntity("ent-1", { name: "Customer", description: "d" }, mockCtx);

      expect(result.success).toBe(true);
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
      expect(prisma.entity.update).toHaveBeenCalled();
      expect(mockTx.entity.update).not.toHaveBeenCalled();
    });

    it("skips the registry when no name is supplied", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, description: "d" } as never);

      const result = await updateEntity("ent-1", { description: "d" }, mockCtx);

      expect(result.success).toBe(true);
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    });

    it("flags the draft and marks the stored source stale when the description changes (R45)", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: null } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, description: "d" } as never);

      await updateEntity("ent-1", { description: "d" }, mockCtx);

      expect(prisma.entity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            description: "d",
            hasUnpublishedChanges: true,
            metadata: { sourceStale: true },
          }),
        })
      );
    });

    it("a rename marks the stored source stale, keeping the other metadata (R45)", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        ...existing, description: "", metadata: { tags: ["a"], schemaVersions: { avro: [] } },
      } as never);
      mockTx.entity.update.mockResolvedValue({ ...existing, name: "CustomerV2" } as never);

      await updateEntity("ent-1", { name: "CustomerV2" }, mockCtx);

      expect(mockTx.entity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "CustomerV2",
            hasUnpublishedChanges: true,
            metadata: { tags: ["a"], schemaVersions: { avro: [] }, sourceStale: true },
          }),
        })
      );
    });

    it("a tags edit marks the stored source stale", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: { tags: [] } } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing } as never);

      await updateEntity("ent-1", { metadata: { tags: ["sales"] } }, mockCtx);

      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: { metadata: Record<string, unknown> } };
      expect(call.data.metadata).toEqual({ tags: ["sales"], sourceStale: true });
    });

    it("does not flag the draft or touch metadata on a status-only change", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: null } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "ACTIVE" } as never);

      const result = await updateEntity("ent-1", { status: "ACTIVE" }, mockCtx);

      expect(result.success).toBe(true);
      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data).not.toHaveProperty("hasUnpublishedChanges");
      expect(call.data.metadata).toBeUndefined();
    });

    it("a lifecycle-only metadata change (deprecation) neither flags the draft nor invents sourceStale", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        ...existing, status: "ACTIVE", description: "", metadata: { tags: [] },
      } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "DEPRECATED" } as never);

      await updateEntity(
        "ent-1",
        { status: "DEPRECATED", metadata: { tags: [], deprecation: { deprecated: true } } },
        mockCtx
      );

      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data).not.toHaveProperty("hasUnpublishedChanges");
      expect(call.data.metadata).toEqual({ tags: [], deprecation: { deprecated: true } });
    });

    it("keeps metadata.sourceStale when the caller replaces metadata with a copy that lacks it, even for a lifecycle-only change", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        ...existing, status: "ACTIVE", description: "", metadata: { tags: [], sourceStale: true },
      } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "DEPRECATED" } as never);

      await updateEntity(
        "ent-1",
        { status: "DEPRECATED", metadata: { tags: [], deprecation: { deprecated: true } } },
        mockCtx
      );

      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: { metadata: Record<string, unknown> } };
      expect(call.data.metadata).toEqual({ tags: [], deprecation: { deprecated: true }, sourceStale: true });
    });

    describe("retiring: blocked while an event holds the entity's LATEST version", () => {
      const deprecated = { ...existing, status: "DEPRECATED", latestVersionId: "ev-2" };
      const spec = { id: "ev-1", name: "checkout", domainId: "dom-1", productId: "prd-1", domain: { name: "payments" }, product: { name: "checkout" } };
      const retire = () => updateEntity("ent-1", { status: "RETIRED" }, mockCtx);

      beforeEach(() => {
        vi.mocked(prisma.entity.findUnique).mockResolvedValue(deprecated as never);
        vi.mocked(prisma.entity.update).mockResolvedValue({ ...deprecated, status: "RETIRED" } as never);
        vi.mocked(prisma.schemaReference.findMany).mockResolvedValue([]);
      });

      it("returns IN_USE naming the event when a draft or published edge points at the latest version; nothing is written", async () => {
        vi.mocked(prisma.schemaReference.findMany).mockResolvedValueOnce([{ fromKind: "EVENT_SPEC", fromId: "ev-1", toId: "ev-2" }] as never);
        vi.mocked(prisma.entityVersion.findUnique).mockResolvedValueOnce({ major: 2, minor: 0 } as never);
        vi.mocked(prisma.eventSpec.findMany).mockResolvedValueOnce([spec] as never);

        const result = await retire();

        expect(result).toMatchObject({
          success: false,
          error: {
            code: "IN_USE",
            message: 'Entity "Customer" cannot be retired: its latest version is pinned by event checkout (payments/checkout).',
            details: { referrers: [{ eventId: "ev-1", name: "checkout", referencedVersions: ["2.0"], draft: true, published: false }], truncated: false },
          },
        });
        expect(prisma.schemaReference.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ toKind: "ENTITY_VERSION", toId: { in: ["ev-2"] } }) })
        );
        expect(prisma.eventSpec.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["ev-1"] }, tenantId: "tenant-1" } }));
        expect(prisma.entity.update).not.toHaveBeenCalled();
      });

      it("retires when nothing holds the latest version", async () => {
        const result = await retire();

        expect(result.success).toBe(true);
        expect(prisma.entity.update).toHaveBeenCalled();
      });

      it("does not look at events for any other transition", async () => {
        vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, status: "ACTIVE", latestVersionId: "ev-2" } as never);
        vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "DEPRECATED" } as never);

        const result = await updateEntity("ent-1", { status: "DEPRECATED" }, mockCtx);

        expect(result.success).toBe(true);
        expect(prisma.schemaReference.findMany).not.toHaveBeenCalled();
      });

      it("keeps the transition rules first: a retire that is not allowed reports the transition, not events", async () => {
        vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, status: "ACTIVE", latestVersionId: "ev-2" } as never);

        const result = await retire();

        expect(result).toMatchObject({ success: false, error: { code: "INVALID_TRANSITION" } });
        expect(prisma.schemaReference.findMany).not.toHaveBeenCalled();
      });

      it("a failing lookup is a DB_ERROR with the generic message, not a throw", async () => {
        vi.mocked(prisma.schemaReference.findMany).mockRejectedValueOnce(new Error("connection lost to 10.0.0.5:5432"));

        expect(await retire()).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
        expect(prisma.entity.update).not.toHaveBeenCalled();
      });
    });
  });


  describe("deleteEntity", () => {
    const existing = { id: "ent-1", name: "Order", tenantId: "tenant-1" };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fkError = () => Object.assign(new Error("Foreign key constraint violated on the constraint: `traits_headersEntityId_fkey`"), { code: "P2003" });
    const rawQuery = (state: string) =>
      Object.assign(new Error('Raw query failed. relation "entities" deadlock'), { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: state } } } });
    const deleteAudits = () =>
      vi.mocked(prisma.auditLog.create).mock.calls.filter(([args]) => (args as { data: { action: string } }).data.action === "DELETE");

    beforeEach(() => {
      consoleError.mockClear();
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(existing as never);
      vi.mocked(prisma.entity.delete).mockResolvedValue({} as never);
      vi.mocked(prisma.trait.findMany).mockResolvedValue([]);
      vi.mocked(prisma.entityVersion.findMany).mockResolvedValue([]);
      vi.mocked(prisma.schemaReference.findMany).mockResolvedValue([]);
      vi.mocked(prisma.eventSpec.findMany).mockResolvedValue([]);
    });

    it("returns success on delete, after checking pins (tenant-scoped) and referencing entities", async () => {
      const result = await deleteEntity("ent-1", mockCtx);
      expect(result.success).toBe(true);
      expect(prisma.trait.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-1" }) }));
      expect(prisma.entityVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { entityId: "ent-1" } }));
      expect(prisma.entity.delete).toHaveBeenCalledWith({ where: { id: "ent-1" } });
      expect(deleteAudits()).toHaveLength(1);
    });

    it("returns not-found error for missing entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);

      const result = await deleteEntity("nonexistent", mockCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
      expect(prisma.entity.delete).not.toHaveBeenCalled();
    });

    it("locks the entity row in ONE transaction, then runs the guards on the locked state, then deletes", async () => {
      const order = (mock: unknown) => (mock as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];

      expect((await deleteEntity("ent-1", mockCtx)).success).toBe(true);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect((vi.mocked(prisma.$queryRaw).mock.calls[0][0] as unknown as string[]).join("?")).toBe('SELECT "id" FROM "entities" WHERE "id" = ? FOR UPDATE');
      expect(vi.mocked(prisma.$queryRaw).mock.calls[0][1]).toBe("ent-1");
      expect(order(prisma.$transaction)).toBeLessThan(order(prisma.$queryRaw));
      expect(order(prisma.$queryRaw)).toBeLessThan(order(prisma.trait.findMany)); // the pin guard
      expect(order(prisma.$queryRaw)).toBeLessThan(order(prisma.eventSpec.findMany)); // the event guard
      expect(order(prisma.trait.findMany)).toBeLessThan(order(prisma.entity.delete));
      expect(order(prisma.eventSpec.findMany)).toBeLessThan(order(prisma.entity.delete));
    });

    it("a row that went away between the read and the lock is NOT_FOUND: nothing is deleted or audited", async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([] as never);

      const result = await deleteEntity("ent-1", mockCtx);

      expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND", message: 'Entity with ID "ent-1" not found' } });
      expect(prisma.entity.delete).not.toHaveBeenCalled();
      expect(deleteAudits()).toHaveLength(0);
    });

    describe("an entity-version reference (no FK) blocks the delete BEFORE it is attempted", () => {
      it("returns IN_USE naming the referencing entity + versions; nothing is deleted or audited", async () => {
        vi.mocked(prisma.entityVersion.findMany)
          .mockResolvedValueOnce([{ id: "ev-money-1" }] as never) // this entity's versions
          .mockResolvedValueOnce([{ major: 1, minor: 0, entity: { id: "ent-cart", name: "Cart" } }] as never); // the edge source
        vi.mocked(prisma.schemaReference.findMany).mockResolvedValueOnce([{ fromId: "ev-cart-1" }] as never);

        const result = await deleteEntity("ent-1", mockCtx);

        expect(result).toMatchObject({
          success: false,
          error: {
            code: "IN_USE",
            message: 'Entity "Order" cannot be deleted: it is referenced by published versions of Entity "Cart" (v1.0).',
            details: { entities: [{ id: "ent-cart", name: "Cart", versions: ["1.0"] }] },
          },
        });
        expect(prisma.schemaReference.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ fromKind: "ENTITY_VERSION", toKind: "ENTITY_VERSION", toId: { in: ["ev-money-1"] } }) })
        );
        expect(prisma.entity.delete).not.toHaveBeenCalled();
        expect(deleteAudits()).toHaveLength(0);
      });
    });

    describe("when a foreign key blocks the delete (P2003)", () => {
      it("returns IN_USE naming the library traits whose headers pin holds the entity", async () => {
        vi.mocked(prisma.entity.delete).mockRejectedValueOnce(fkError());
        // the pre-delete check finds nothing (the pin landed meanwhile), the post-P2003 check does
        vi.mocked(prisma.trait.findMany).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "t1", name: "CloudEvents" }] as never);

        const result = await deleteEntity("ent-1", mockCtx);
        expect(result).toMatchObject({
          success: false,
          error: {
            code: "IN_USE",
            message: 'Entity "Order" cannot be deleted: it is used by Trait "CloudEvents".',
            details: { traits: [{ id: "t1", name: "CloudEvents" }], entities: [] },
          },
        });
        expect(deleteAudits()).toHaveLength(0);
      });

      it("returns a generic IN_USE (never the driver text) when no pin explains it", async () => {
        vi.mocked(prisma.entity.delete).mockRejectedValueOnce(fkError());
        const result = await deleteEntity("ent-1", mockCtx);
        expect(result).toEqual({
          success: false,
          error: { code: "IN_USE", message: "This entity is referenced by another record and cannot be deleted.", suggestedFix: "Remove the references first." },
        });
      });
    });

    describe("an event document that names the entity (no FK: only the event guard stops the delete)", () => {
      const spec = { id: "ev-1", name: "checkout", domainId: "dom-1", productId: "prd-1", domain: { name: "payments" }, product: { name: "checkout" } };

      it("keeps the trait-pin answer byte for byte when no event names the entity (regression)", async () => {
        vi.mocked(prisma.trait.findMany).mockResolvedValueOnce([{ id: "t1", name: "CloudEvents" }] as never);

        const result = await deleteEntity("ent-1", mockCtx);

        expect(result).toEqual({
          success: false,
          error: {
            code: "IN_USE",
            message: 'Entity "Order" cannot be deleted: it is used by Trait "CloudEvents".',
            details: { traits: [{ id: "t1", name: "CloudEvents" }], entities: [] },
            suggestedFix: "Re-pin or delete those traits first, then delete the entity.",
          },
        });
        // the event guard still looked, inside the entity's tenant
        expect(prisma.eventSpec.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-1" }) }));
        expect(prisma.entity.delete).not.toHaveBeenCalled();
        expect(deleteAudits()).toHaveLength(0);
      });

      it("blocks BEFORE deleting when a draft names the entity (an unpinned pin has no edge), naming the event", async () => {
        vi.mocked(prisma.eventSpec.findMany).mockResolvedValueOnce([spec] as never);

        const result = await deleteEntity("ent-1", mockCtx);

        expect(result).toMatchObject({
          success: false,
          error: { code: "IN_USE", message: 'Entity "Order" cannot be deleted: it is pinned by event checkout (payments/checkout).' },
        });
        expect(prisma.entity.delete).not.toHaveBeenCalled();
        expect(deleteAudits()).toHaveLength(0);
      });

      it("merges with a trait pin into one IN_USE that keeps the trait details and gains `events`", async () => {
        vi.mocked(prisma.trait.findMany).mockResolvedValueOnce([{ id: "t1", name: "CloudEvents" }] as never);
        vi.mocked(prisma.eventSpec.findMany).mockResolvedValueOnce([spec] as never);

        const result = await deleteEntity("ent-1", mockCtx);

        expect(result).toMatchObject({
          success: false,
          error: {
            code: "IN_USE",
            message: 'Entity "Order" cannot be deleted: it is used by Trait "CloudEvents", and it is pinned by event checkout (payments/checkout).',
            details: { traits: [{ id: "t1", name: "CloudEvents" }], entities: [], events: { truncated: false } },
          },
        });
        expect(prisma.entity.delete).not.toHaveBeenCalled();
      });

      it("a failing event lookup is a DB_ERROR with the generic message, not a throw", async () => {
        vi.mocked(prisma.eventSpec.findMany).mockRejectedValueOnce(new Error("relation event_specs does not exist"));

        expect(await deleteEntity("ent-1", mockCtx)).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
        expect(prisma.entity.delete).not.toHaveBeenCalled();
      });
    });

    describe("never throws and never carries driver text", () => {
      it("a lock timeout / deadlock / expired transaction is a retryable CONFLICT without a pin lookup", async () => {
        for (const error of [rawQuery("40P01"), rawQuery("55P03"), rawQuery("40001"), Object.assign(new Error("Transaction API error"), { code: "P2028" })]) {
          vi.mocked(prisma.trait.findMany).mockClear();
          vi.mocked(prisma.entity.delete).mockRejectedValueOnce(error);
          const result = await deleteEntity("ent-1", mockCtx);
          expect(result).toEqual({
            success: false,
            error: { code: "CONFLICT", message: "Entity changed concurrently, try again", suggestedFix: "Reload and try deleting again." },
          });
          // the one pre-delete check ran; the failure path did not look for pins again
          expect(prisma.trait.findMany).toHaveBeenCalledTimes(1);
        }
      });

      it("any other database error is a DB_ERROR with the generic message; the original is only logged", async () => {
        const error = new Error("connection lost to 10.0.0.5:5432");
        vi.mocked(prisma.entity.delete).mockRejectedValueOnce(error);
        const result = await deleteEntity("ent-1", mockCtx);
        expect(result).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("deleteEntity ent-1"), error);
      });

      it("a failing lookup of the entity itself or of its pins is a DB_ERROR, not a throw", async () => {
        vi.mocked(prisma.entity.findUnique).mockRejectedValueOnce(new Error("pool exhausted"));
        expect(await deleteEntity("ent-1", mockCtx)).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });

        vi.mocked(prisma.schemaReference.findMany).mockRejectedValueOnce(new Error("relation schema_references does not exist"));
        vi.mocked(prisma.entityVersion.findMany).mockResolvedValueOnce([{ id: "ev1" }] as never);
        expect(await deleteEntity("ent-1", mockCtx)).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
        expect(prisma.entity.delete).not.toHaveBeenCalled();
      });

      it("a session whose user no longer exists is UNAUTHORIZED", async () => {
        (prisma as unknown as { user: unknown }).user = { findUnique: vi.fn().mockResolvedValue(null) };
        try {
          const result = await deleteEntity("ent-1", mockCtx);
          expect(result).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
          expect(prisma.entity.delete).not.toHaveBeenCalled();
        } finally {
          delete (prisma as unknown as { user?: unknown }).user;
        }
      });
    });
  });
});
