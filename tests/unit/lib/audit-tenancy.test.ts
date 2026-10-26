// @vitest-environment node
/**
 * The audit trail has a tenant (access-control Task 6, KD-016): `withAudit` writes `audit_log.tenantId` from the acting tenant, so the compliance
 * Audit Trail can be scoped by it. The acting tenant is passed by a caller that has it (`tenantId`), else it is the tenant of the row the entry is
 * about: a row that carries its own tenant says so in its state (a CREATE is written with the placeholder entityId "pending" and has no id to look
 * up), the others are found through their entity, domain or product. An entry about something no tenant owns (a user, the git connection) has none.
 * A failure to find the tenant never loses the entry: it is written without one (shown to platform administrators only) and the problem is logged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1" }) },
    entity: { findUnique: vi.fn().mockResolvedValue(null) },
    field: { findUnique: vi.fn().mockResolvedValue(null) },
    domain: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findUnique: vi.fn().mockResolvedValue(null) },
    eventSpec: { findUnique: vi.fn().mockResolvedValue(null) },
    trait: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

import { withAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";

const written = () => vi.mocked(prisma.auditLog.create).mock.calls.at(-1)?.[0]?.data as Record<string, unknown>;
const audit = (over: Partial<Parameters<typeof withAudit>[0]> & { result?: unknown }) =>
  withAudit({ action: "CREATE", entityType: "Entity", entityId: "pending", userId: "user-1", fn: async () => over.result ?? { id: "x" }, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.field.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.domain.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.product.findUnique).mockResolvedValue(null);
});

describe("an explicit tenant (the caller knows the acting tenant)", () => {
  it("is written as it is, whatever the row says", async () => {
    await audit({ tenantId: "t-acting", result: { id: "e1", tenantId: "t-row" } });
    expect(written().tenantId).toBe("t-acting");
    expect(prisma.entity.findUnique).not.toHaveBeenCalled();
  });

  it("null is a platform-level entry: no tenant is written and none is looked for", async () => {
    await audit({ entityType: "Domain", tenantId: null, result: { id: "d1", tenantId: "t-row" } });
    expect(written()).not.toHaveProperty("tenantId");
    expect(prisma.domain.findUnique).not.toHaveBeenCalled();
  });
});

describe("the tenant of the row the entry is about", () => {
  it("a CREATE of a row that carries its tenant (entity, domain, event, trait): the state names it, nothing is looked up", async () => {
    for (const entityType of ["Entity", "Domain", "EventSpec", "Trait"]) {
      await audit({ entityType, result: { id: "r1", tenantId: "t1" } });
      expect(written().tenantId, entityType).toBe("t1");
    }
    expect(prisma.entity.findUnique).not.toHaveBeenCalled();
    expect(prisma.domain.findUnique).not.toHaveBeenCalled();
  });

  it("a CREATE of an event or a trait whose answer carries no tenant (a detail) but its own id: the row just written is found by that id", async () => {
    vi.mocked(prisma.eventSpec.findUnique).mockResolvedValue({ tenantId: "t-event" } as never);
    await audit({ entityType: "EventSpec", result: { id: "ev1", name: "orders" } });
    expect(written().tenantId).toBe("t-event");
    expect(vi.mocked(prisma.eventSpec.findUnique).mock.calls[0][0]).toMatchObject({ where: { id: "ev1" } });

    vi.mocked(prisma.trait.findUnique).mockResolvedValue({ tenantId: "t-trait" } as never);
    await audit({ entityType: "Trait", result: { id: "tr1", name: "headers" } });
    expect(written().tenantId).toBe("t-trait");
  });

  it("an UPDATE of an event is found through the event the entry names, before the write", async () => {
    vi.mocked(prisma.eventSpec.findUnique).mockResolvedValue({ tenantId: "t-event" } as never);
    await audit({ action: "UPDATE", entityType: "EventSpec", entityId: "ev1", result: { id: "ev1" } });
    expect(written().tenantId).toBe("t-event");
  });

  it("a CREATE of a field names its entity in the state: the entity's tenant", async () => {
    vi.mocked(prisma.entity.findUnique).mockResolvedValue({ tenantId: "t2" } as never);
    await audit({ entityType: "Field", result: { id: "f1", entityId: "e1" } });
    expect(written().tenantId).toBe("t2");
    expect(vi.mocked(prisma.entity.findUnique).mock.calls[0][0]).toMatchObject({ where: { id: "e1" } });
  });

  it("a CREATE of a product names its domain in the state: the domain's tenant", async () => {
    vi.mocked(prisma.domain.findUnique).mockResolvedValue({ tenantId: "t3" } as never);
    await audit({ entityType: "Product", result: { id: "p1", domainId: "d1" } });
    expect(written().tenantId).toBe("t3");
    expect(vi.mocked(prisma.domain.findUnique).mock.calls[0][0]).toMatchObject({ where: { id: "d1" } });
  });

  it("an UPDATE or DELETE of an entity whose state does not say: the entity is looked up by its id", async () => {
    vi.mocked(prisma.entity.findUnique).mockResolvedValue({ tenantId: "t4" } as never);
    await audit({ action: "UPDATE", entityId: "e9", beforeState: { name: "Old" }, result: { id: "e9", name: "New" } });
    expect(written().tenantId).toBe("t4");
    expect(vi.mocked(prisma.entity.findUnique).mock.calls[0][0]).toMatchObject({ where: { id: "e9" } });
  });

  it("the state of a DELETED row (before it went) names its tenant when the row is gone", async () => {
    await audit({ action: "DELETE", entityId: "e9", beforeState: { id: "e9", tenantId: "t5" }, result: null as unknown as object, fn: async () => null });
    expect(written().tenantId).toBe("t5");
  });

  it("a field is found through its entity, a product through its domain, an annotation through the entity or the field it is on", async () => {
    vi.mocked(prisma.field.findUnique).mockResolvedValue({ entity: { tenantId: "t6" } } as never);
    await audit({ action: "UPDATE", entityType: "Field", entityId: "f1", result: { id: "f1" } });
    expect(written().tenantId).toBe("t6");

    vi.mocked(prisma.product.findUnique).mockResolvedValue({ domain: { tenantId: "t7" } } as never);
    await audit({ action: "UPDATE", entityType: "Product", entityId: "p1", result: { id: "p1" } });
    expect(written().tenantId).toBe("t7");

    vi.mocked(prisma.entity.findUnique).mockResolvedValue({ tenantId: "t8" } as never);
    await audit({ action: "annotation.create", entityType: "Annotation", entityId: "e1", result: { id: "a1" } });
    expect(written().tenantId).toBe("t8");

    vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.field.findUnique).mockResolvedValue({ entity: { tenantId: "t9" } } as never);
    await audit({ action: "annotation.create", entityType: "Annotation", entityId: "f1", result: { id: "a2" } });
    expect(written().tenantId).toBe("t9");
  });

  it("an entry about something no tenant owns (a user, the git connection) has none, and nothing is looked up", async () => {
    for (const entityType of ["User", "GitConfig", "GitPullRequest"]) {
      await audit({ action: "UPDATE", entityType, entityId: "x1", result: { id: "x1" } });
      expect(written(), entityType).not.toHaveProperty("tenantId");
    }
    expect(prisma.entity.findUnique).not.toHaveBeenCalled();
  });

  it("a row that cannot be found yields an entry without a tenant (platform administrators only), never an error", async () => {
    await audit({ action: "UPDATE", entityId: "gone", result: { id: "gone" } });
    expect(written()).not.toHaveProperty("tenantId");
  });

  it("a state that names no usable tenant (blank, not text) is ignored", async () => {
    await audit({ result: { id: "e1", tenantId: "" } });
    await audit({ result: { id: "e1", tenantId: { x: 1 } } });
    expect(written()).not.toHaveProperty("tenantId");
  });

  it("a failing look-up does not lose the entry: it is written without a tenant and the problem is logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(prisma.entity.findUnique).mockRejectedValue(new Error("connection reset"));
    await expect(audit({ action: "UPDATE", entityId: "e1", result: { id: "e1" } })).resolves.toEqual({ id: "e1" });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(written()).not.toHaveProperty("tenantId");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("the rest of the entry is as it always was (the action, the type, the user, both states)", async () => {
    await audit({ action: "UPDATE", entityId: "e1", beforeState: { name: "a" }, result: { id: "e1", tenantId: "t1" } });
    expect(written()).toEqual({
      action: "UPDATE", entityType: "Entity", entityId: "e1", userId: "user-1",
      beforeState: { name: "a" }, afterState: { id: "e1", tenantId: "t1" }, tenantId: "t1",
    });
    await audit({ action: "DELETE", entityId: "e1", fn: async () => null });
    expect(written().afterState).toBe(Prisma.JsonNull);
  });
});
