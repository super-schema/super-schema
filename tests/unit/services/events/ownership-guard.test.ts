import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// withAudit only runs the callback here; the real one needs the app's Prisma singleton.
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: async ({ fn }: { fn: () => Promise<unknown> }) => fn(), AuditUserMissingError };
});

import type { PrismaClient } from "@/generated/prisma/client";
import { deleteEventSpec, renameEventSpec, updateEventSpecDocument } from "@/services/events/event-spec.service";
import { deleteMessage, updateMessage } from "@/services/events/message.service";
import { loadOwnedRow } from "@/services/events/service-guards";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const SECRET = "secret-foreign-name";

/** A Prisma stand-in: any model / method not given in `models` throws if touched (a refused ownership check must stop before it). */
function fakePrisma(models: Record<string, Record<string, unknown>>): PrismaClient {
  return new Proxy(models, {
    get(target, key: string) {
      if (key in target) return target[key];
      throw new Error(`unexpected prisma.${key} access`);
    },
  }) as unknown as PrismaClient;
}
const ctxOf = (models: Record<string, Record<string, unknown>>): ServiceContext => ({ userId: "u1", userRole: "AUTHOR", prisma: fakePrisma(models) });

const product = (id: string, domainId: string, tenantId: string) => ({ findUnique: vi.fn().mockResolvedValue({ id, domainId, domain: { tenantId } }) });
/** The caller acts from product p1 (domain d1, tenant t1). */
const OWNER = { level: "PRODUCT", productId: "p1" } as const;
const OWN_PRODUCT = product("p1", "d1", "t1");
type Level = { tenantId: string; domainId: string | null; productId: string | null };
const OWN_ROW: Level = { tenantId: "t1", domainId: "d1", productId: "p1" };
const FOREIGN_ROWS: Array<[string, Level]> = [
  ["another product of the same domain", { ...OWN_ROW, productId: "p2" }],
  ["another domain of the same tenant", { ...OWN_ROW, domainId: "d2", productId: "p9" }],
  ["another tenant", { tenantId: "t2", domainId: "d3", productId: "p3" }],
  ["a domain-level row", { ...OWN_ROW, productId: null }],
  ["a tenant-level row", { ...OWN_ROW, domainId: null, productId: null }],
];

const failure = <T>(r: Result<T>) => {
  if (r.success) throw new Error("expected a failure");
  return r.error;
};

describe("loadOwnedRow (the shared ownership read)", () => {
  it("resolves the scope from the owner, loads the row by the caller's id and returns both", async () => {
    const load = vi.fn().mockResolvedValue({ ...OWN_ROW, id: "m1", name: "OrderCreated" });
    const r = await loadOwnedRow(fakePrisma({ product: OWN_PRODUCT }), { kind: "Message", id: "m1", owner: OWNER, load });
    expect(r).toEqual({ success: true, data: { row: { ...OWN_ROW, id: "m1", name: "OrderCreated" }, scope: OWN_ROW } });
    expect(load).toHaveBeenCalledWith("m1");
    expect(OWN_PRODUCT.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1" } }));
  });

  it("supports domain- and tenant-level owners (traits)", async () => {
    const load = vi.fn().mockResolvedValue({ tenantId: "t1", domainId: "d1", productId: null });
    const db = fakePrisma({ domain: { findUnique: vi.fn().mockResolvedValue({ id: "d1", tenantId: "t1" }) } });
    expect((await loadOwnedRow(db, { kind: "Trait", id: "t1", owner: { level: "DOMAIN", domainId: "d1" }, load })).success).toBe(true);
    const tenantLoad = vi.fn().mockResolvedValue({ tenantId: "t1", domainId: null, productId: null });
    expect((await loadOwnedRow(fakePrisma({}), { kind: "Trait", id: "t1", owner: { level: "TENANT", tenantId: "t1" }, load: tenantLoad })).success).toBe(true);
  });

  it.each(FOREIGN_ROWS)("refuses %s with FORBIDDEN, no details, labelled by the caller's id and never by the row's name", async (_label, level) => {
    const load = vi.fn().mockResolvedValue({ ...level, id: "m1", name: SECRET });
    const error = failure(await loadOwnedRow(fakePrisma({ product: OWN_PRODUCT }), { kind: "Message", id: "m1", owner: OWNER, load }));
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toMatch(/^Message "m1" is owned by another .+ scope and is read-only here\.$/);
    expect(error.suggestedFix).toEqual(expect.any(String));
    expect("details" in error).toBe(false);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it("returns NOT_FOUND for an unknown row (labelled by the caller's id) and for an unknown owner (load never runs)", async () => {
    expect(failure(await loadOwnedRow(fakePrisma({ product: OWN_PRODUCT }), { kind: "Event spec", id: "s9", owner: OWNER, load: async () => null }))).toEqual({
      code: "NOT_FOUND", message: 'Event spec "s9" not found',
    });
    const load = vi.fn();
    const unknownProduct = fakePrisma({ product: { findUnique: vi.fn().mockResolvedValue(null) } });
    expect(failure(await loadOwnedRow(unknownProduct, { kind: "Message", id: "m1", owner: { level: "PRODUCT", productId: "nope" }, load }))).toMatchObject({ code: "NOT_FOUND" });
    expect(load).not.toHaveBeenCalled();
  });

  describe("a database failure", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => consoleError.mockRestore());

    it("in the scope lookup or the row load becomes a DB_ERROR with the generic message (the driver text is only logged)", async () => {
      const raw = new Error('connect ECONNREFUSED 10.0.0.5:5432 relation "messages"');
      const scopeDown = fakePrisma({ product: { findUnique: vi.fn().mockRejectedValue(raw) } });
      const loadDown = vi.fn().mockRejectedValue(raw);
      for (const r of [
        await loadOwnedRow(scopeDown, { kind: "Message", id: "m1", owner: OWNER, load: vi.fn() }),
        await loadOwnedRow(fakePrisma({ product: OWN_PRODUCT }), { kind: "Message", id: "m1", owner: OWNER, load: loadDown }),
      ]) {
        expect(r).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
        expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|messages/);
      }
      expect(consoleError).toHaveBeenCalledWith("[guardRead] database error", raw);
    });
  });
});

describe("message and event spec writes from another product: FORBIDDEN labelled by the caller's own id (never row.name)", () => {
  const hygiene = <T,>(r: Result<T>, label: string) => {
    const error = failure(r);
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain(label);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect("details" in error).toBe(false);
  };

  it("messages: updateMessage / deleteMessage", async () => {
    const foreign = ctxOf({ product: OWN_PRODUCT, message: { findUnique: vi.fn().mockResolvedValue({ ...OWN_ROW, productId: "p2", id: "m1", name: SECRET }) } });
    hygiene(await updateMessage("m1", { name: "x", payload: { entityId: "e1" } }, OWNER, foreign), 'Message "m1"');
    hygiene(await deleteMessage("m1", OWNER, foreign), 'Message "m1"');
  });

  it("event specs: updateEventSpecDocument / renameEventSpec / deleteEventSpec", async () => {
    const foreign = ctxOf({ product: OWN_PRODUCT, eventSpec: { findUnique: vi.fn().mockResolvedValue({ ...OWN_ROW, productId: "p2", id: "s1", name: SECRET }) } });
    hygiene(await updateEventSpecDocument("s1", { info: { title: "x" }, servers: [], operations: [] }, OWNER, foreign), 'Event spec "s1"');
    hygiene(await renameEventSpec("s1", "renamed", OWNER, foreign), 'Event spec "s1"');
    hygiene(await deleteEventSpec("s1", OWNER, foreign), 'Event spec "s1"');
  });

  it("an unknown id is NOT_FOUND by the caller's id, and a DB failure in the ownership read is a DB_ERROR Result, not a throw", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const missing = ctxOf({ product: OWN_PRODUCT, message: { findUnique: vi.fn().mockResolvedValue(null) }, eventSpec: { findUnique: vi.fn().mockResolvedValue(null) } });
      expect(failure(await deleteMessage("m404", OWNER, missing))).toMatchObject({ code: "NOT_FOUND", message: 'Message "m404" not found' });
      expect(failure(await deleteEventSpec("s404", OWNER, missing))).toMatchObject({ code: "NOT_FOUND", message: 'Event spec "s404" not found' });

      const down = ctxOf({ product: OWN_PRODUCT, message: { findUnique: vi.fn().mockRejectedValue(new Error("pool exhausted")) }, eventSpec: { findUnique: vi.fn().mockRejectedValue(new Error("pool exhausted")) } });
      expect(await deleteMessage("m1", OWNER, down)).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
      expect(await deleteEventSpec("s1", OWNER, down)).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
    } finally {
      consoleError.mockRestore();
    }
  });
});
