// @vitest-environment node
/**
 * The type-mapping service decides with the policy over the caller's assignments (no role names):
 * - a PER-ENTITY override (create, acknowledge a lossy mapping, delete) is `typemapping.entity` over THE ENTITY it is for: an author or above where
 *   the entity lives; an entity that does not exist and one nothing of the caller's covers read the same;
 * - a GLOBAL override (no entity) reaches every tenant (the table has no tenant column): `typemapping.global`, a platform administrator's act;
 * - the readers list a per-entity override only for an entity of the tenant in view that the caller may read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign } from "../../helpers/access-mocks";
import { ROLE_HIERARCHY } from "@/types/schemas/rbac";
import { roleAtLeast } from "@/lib/access";

const h = vi.hoisted(() => ({
  entityFindUnique: vi.fn(), entityFindMany: vi.fn(), overrideFindMany: vi.fn(), overrideUpsert: vi.fn(), overrideDelete: vi.fn(), ackUpsert: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findUnique: h.entityFindUnique, findMany: h.entityFindMany },
    typeMappingOverride: { findMany: h.overrideFindMany, upsert: h.overrideUpsert, delete: h.overrideDelete },
    lossyMappingAck: { upsert: h.ackUpsert },
  },
}));

import { acknowledgeLossyMapping, createEntityOverride, createGlobalOverride, createOverride, deleteOverride, getAllMappings, getMappingsForTarget } from "@/services/type-mapping.service";
import type { ServiceContext } from "@/types/service-context";

const T = "tenant-1";
const ctxOf = (assignments: ServiceContext["assignments"], extra: Partial<ServiceContext> = {}): ServiceContext =>
  ({ userId: "u1", userRole: "VIEWER", assignments, prisma: {} as never, ...extra });

const INPUT = { sourceType: "string", targetFormat: "bigquery", mappedType: "BYTES", isLossy: false };
const ROW = (overrides: Record<string, unknown> = {}) => ({
  id: "o1", sourceType: "string", targetFormat: "bigquery", mappedType: "BYTES", isLossy: false, lossDescription: null, justification: "j", approvedBy: "u0",
  entityId: null, createdAt: new Date(), updatedAt: new Date(), ...overrides,
});
const place = (tenantId: string, domainId: string | null = "dom-a", productId: string | null = "prod-a") => ({ tenantId, domainId, productId, product: { domainId } });

beforeEach(() => {
  vi.clearAllMocks();
  h.entityFindUnique.mockResolvedValue(place(T));
  h.entityFindMany.mockResolvedValue([]);
  h.overrideFindMany.mockResolvedValue([]);
  h.overrideUpsert.mockResolvedValue(ROW());
  h.overrideDelete.mockResolvedValue(ROW());
  h.ackUpsert.mockResolvedValue({});
});

const writes = () => [h.overrideUpsert, h.overrideDelete, h.ackUpsert].filter((fn) => fn.mock.calls.length > 0);

const ENTITY_OPS: Array<[string, (ctx: ServiceContext) => Promise<{ success: boolean; error?: { code: string; message: string } }>]> = [
  ["createOverride (per-entity)", (ctx) => createOverride({ ...INPUT, entityId: "ent-1" }, ctx)],
  ["createEntityOverride", (ctx) => createEntityOverride({ ...INPUT, entityId: "ent-1", justification: "why" }, ctx)],
  ["acknowledgeLossyMapping", (ctx) => acknowledgeLossyMapping({ entityId: "ent-1", sourceType: "string", targetFormat: "bigquery" }, ctx)],
  ["deleteOverride (per-entity)", (ctx) => deleteOverride("string", "bigquery", ctx, "ent-1")],
];

describe.each(ENTITY_OPS)("%s is typemapping.entity over the entity", (_name, call) => {
  it("is open from AUTHOR up (a compliance officer and an administrator too) and refused below it, nothing written", async () => {
    for (const role of ROLE_HIERARCHY) {
      vi.clearAllMocks();
      h.entityFindUnique.mockResolvedValue(place(T));
      h.overrideUpsert.mockResolvedValue(ROW());
      h.overrideDelete.mockResolvedValue(ROW());
      h.ackUpsert.mockResolvedValue({});
      const result = await call(ctxOf([assign.tenant(role, T)]));
      if (roleAtLeast(role, "AUTHOR")) expect(result.success, role).toBe(true);
      else {
        expect(result.success, role).toBe(false);
        expect(result.error?.code, role).toBe("PERMISSION_DENIED");
        expect(writes(), role).toHaveLength(0);
      }
    }
  });

  it("a platform administrator may; a context with no assignments never", async () => {
    expect((await call(ctxOf([assign.global()]))).success).toBe(true);
    for (const assignments of [undefined, []]) {
      const result = await call(ctxOf(assignments));
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("NOT_FOUND");
    }
  });

  it("an entity of another tenant, a missing one and one outside the caller's domain are the same NOT_FOUND, nothing written", async () => {
    h.entityFindUnique.mockResolvedValue(place("tenant-2"));
    const foreign = await call(ctxOf([assign.tenant("ADMIN", T)]));
    h.entityFindUnique.mockResolvedValue(null);
    const missing = await call(ctxOf([assign.tenant("ADMIN", T)]));
    h.entityFindUnique.mockResolvedValue(place(T, "dom-b"));
    const sibling = await call(ctxOf([assign.domain("ADMIN", T, "dom-a")]));
    for (const result of [foreign, missing, sibling]) expect(result.error).toEqual({ code: "NOT_FOUND", message: 'Entity "ent-1" not found', suggestedFix: "Verify the entity ID." });
    expect(writes()).toHaveLength(0);
  });

  it("a domain-scoped author may over THEIR domain's entity, a product-scoped one over their product's only", async () => {
    expect((await call(ctxOf([assign.domain("AUTHOR", T, "dom-a")]))).success).toBe(true);
    expect((await call(ctxOf([assign.product("AUTHOR", T, "dom-a", "prod-a")]))).success).toBe(true);
    const sibling = await call(ctxOf([assign.product("AUTHOR", T, "dom-a", "prod-b")]));
    expect(sibling.error?.code).toBe("NOT_FOUND");
    const low = await call(ctxOf([assign.domain("VIEWER", T, "dom-a")]));
    expect(low.error?.code).toBe("PERMISSION_DENIED");
  });

  it("names no role in the refusal", async () => {
    const result = await call(ctxOf([assign.tenant("VIEWER", T)]));
    expect(JSON.stringify(result.error)).not.toMatch(/AUTHOR|STEWARD|ADMIN|VIEWER|current role/);
  });
});

describe("a GLOBAL override is a platform administrator's act", () => {
  const GLOBAL_OPS: Array<[string, (ctx: ServiceContext) => Promise<{ success: boolean; error?: { code: string; message: string } }>]> = [
    ["createOverride (no entity)", (ctx) => createOverride(INPUT, ctx)],
    ["createGlobalOverride", (ctx) => createGlobalOverride({ ...INPUT, justification: "why" }, ctx)],
    ["deleteOverride (no entity)", (ctx) => deleteOverride("string", "bigquery", ctx)],
  ];

  it.each(GLOBAL_OPS)("%s: refused to every tenant-scoped role, an administrator of every tenant included; allowed to a global administrator", async (_name, call) => {
    for (const role of ROLE_HIERARCHY) {
      const result = await call(ctxOf([assign.tenant(role, T)]));
      expect(result.error?.code, role).toBe("PERMISSION_DENIED");
    }
    for (const assignments of [[assign.tenant("ADMIN", T), assign.tenant("ADMIN", "tenant-2")], [assign.domain("ADMIN", T, "dom-a")], [], undefined]) {
      expect((await call(ctxOf(assignments))).success, JSON.stringify(assignments)).toBe(false);
    }
    expect(writes()).toHaveLength(0);
    expect((await call(ctxOf([assign.global()]))).success).toBe(true);
  });

  it("the entity is not read at all (a global override has none)", async () => {
    await createGlobalOverride({ ...INPUT, justification: "why" }, ctxOf([assign.global()]));
    expect(h.entityFindUnique).not.toHaveBeenCalled();
  });
});

describe("createEntityOverride judges the access before it tells what is wrong with the input", () => {
  it("a missing justification is told only to somebody who may override that entity's mappings", async () => {
    const codeFor = async (role: "VIEWER" | "AUTHOR") => {
      const result = await createEntityOverride({ ...INPUT, entityId: "ent-1", justification: " " }, ctxOf([assign.tenant(role, T)]));
      return result.success ? "ok" : result.error.code;
    };
    expect(await codeFor("VIEWER")).toBe("PERMISSION_DENIED");
    expect(await codeFor("AUTHOR")).toBe("VALIDATION_ERROR");
  });
});

describe("the readers list a per-entity override only for an entity the caller may read in the tenant in view", () => {
  const rows = [ROW({ id: "g" }), ROW({ id: "a", entityId: "ent-a" }), ROW({ id: "b", entityId: "ent-b" })];

  beforeEach(() => {
    h.overrideFindMany.mockResolvedValue(rows);
    h.entityFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) => args.where.id.in.filter((id) => id === "ent-a").map((id) => ({ id })));
  });

  it("with a tenant in the context only global overrides and those of readable entities of that tenant are returned", async () => {
    const result = await getAllMappings(ctxOf([assign.tenant("VIEWER", T)], { tenantId: T }));
    const overridden = result.success ? result.data.filter((p) => p.isOverride).map((p) => p.entityId ?? "global") : [];
    expect(overridden.sort()).toEqual(["ent-a", "global"]);
    expect(h.entityFindMany).toHaveBeenCalledWith({ where: { id: { in: ["ent-a", "ent-b"] }, tenantId: T }, select: { id: true } });
  });

  it("a domain- or product-scoped caller asks for the entities under its scopes only", async () => {
    await getMappingsForTarget("bigquery", ctxOf([assign.domain("VIEWER", T, "dom-a"), assign.product("VIEWER", T, "dom-b", "prod-x")], { tenantId: T }));
    expect(h.entityFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["ent-a", "ent-b"] }, tenantId: T, OR: [{ domainId: { in: ["dom-a"] } }, { productId: { in: ["prod-x"] } }] },
      select: { id: true },
    });
  });

  it("with no tenant in the context (a caller that is not a page) nothing is filtered, and no entity is read", async () => {
    const result = await getAllMappings(ctxOf([assign.global()]));
    expect(result.success && result.data.filter((p) => p.isOverride)).toHaveLength(3);
    expect(h.entityFindMany).not.toHaveBeenCalled();
  });
});
