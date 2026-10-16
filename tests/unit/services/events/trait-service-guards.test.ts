import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// withAudit only runs the callback here; the real one needs the app's Prisma singleton.
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: async ({ fn }: { fn: () => Promise<unknown> }) => fn(), AuditUserMissingError };
});

import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import type { Result } from "@/types/result";
import { createTrait, deleteTrait, getTrait, updateTrait } from "@/services/events/trait.service";
import { MAX_ID_LIST, parseIdList, parseScopeTarget } from "@/services/events/service-guards";

const boom = () => Promise.reject(new Error("connection lost"));

// Every guarded DB failure below is logged server-side (and returned generically); keep the test output quiet and let a test assert the log.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

/** A Prisma stand-in: any model / method not given in `models` throws if touched (validation must stop before it). */
function fakeCtx(models: Record<string, Record<string, unknown>> = {}): ServiceContext {
  const prisma = new Proxy(models, {
    get(target, key: string) {
      if (key in target) return target[key];
      throw new Error(`unexpected prisma.${key} access`);
    },
  }) as unknown as PrismaClient;
  return { userId: "u1", userRole: "AUTHOR", prisma };
}

const code = <T>(r: Result<T>) => (r.success ? "OK" : r.error.code);
const message = <T>(r: Result<T>) => (r.success ? "" : r.error.message);

const domain = { findUnique: vi.fn().mockResolvedValue({ id: "d1", tenantId: "tn" }) };
const traitRow = { id: "t1", name: "CE", kind: "MESSAGE", spec: {}, headersEntityId: null, headersEntityVersionId: null, tenantId: "tn", domainId: "d1", productId: null };

const DOMAIN = { level: "DOMAIN", domainId: "d1" } as const;

describe("service-guards", () => {
  it("parseIdList de-duplicates, rejects non-arrays / non-strings and caps the raw length", () => {
    expect(parseIdList(["a", "b", "a"], "ids")).toEqual({ success: true, data: ["a", "b"] });
    expect(parseIdList([], "ids")).toEqual({ success: true, data: [] });
    for (const bad of [undefined, null, "a", { 0: "a" }, 5]) expect(code(parseIdList(bad, "ids"))).toBe("VALIDATION_ERROR");
    for (const bad of [[1], [""], ["  "], [null], ["a", undefined]]) expect(code(parseIdList(bad, "ids"))).toBe("VALIDATION_ERROR");
    expect(code(parseIdList(Array.from({ length: MAX_ID_LIST }, (_, i) => `m${i}`), "ids"))).toBe("OK");
    expect(code(parseIdList(Array.from({ length: MAX_ID_LIST + 1 }, (_, i) => `m${i}`), "ids"))).toBe("VALIDATION_ERROR");
    expect(code(parseIdList(Array(MAX_ID_LIST + 1).fill("same"), "ids"))).toBe("VALIDATION_ERROR");
  });

  it("parseScopeTarget accepts the three levels and rejects everything else", () => {
    expect(parseScopeTarget({ level: "TENANT", tenantId: "t" })).toEqual({ success: true, data: { level: "TENANT", tenantId: "t" } });
    expect(parseScopeTarget({ level: "DOMAIN", domainId: "d", extra: 1 })).toEqual({ success: true, data: { level: "DOMAIN", domainId: "d" } });
    for (const bad of [undefined, null, "PRODUCT", {}, { level: "PRODUCT" }, { level: "PRODUCT", productId: 1 }, { level: "DOMAIN", domainId: "" }, { level: "NOPE", productId: "p" }]) {
      expect(code(parseScopeTarget(bad))).toBe("VALIDATION_ERROR");
    }
  });
});

describe("trait service never throws on untrusted input", () => {
  const TRAIT = { name: "CE", kind: "MESSAGE" as const };

  it("createTrait rejects malformed input before touching the DB (a tenant target's scope lookup is the only read)", async () => {
    const ctx = fakeCtx({ tenant: { findUnique: vi.fn().mockResolvedValue({ id: "tn" }) } });
    const target = { level: "TENANT", tenantId: "tn" } as const;
    for (const input of [null, undefined, "x", 5, []]) expect(code(await createTrait(target, input as never, ctx))).toBe("VALIDATION_ERROR");
    const bads: Array<Record<string, unknown>> = [
      { ...TRAIT, name: 123 }, { ...TRAIT, name: null }, { ...TRAIT, name: undefined }, { ...TRAIT, name: ["CE"] },
      { ...TRAIT, kind: "NOPE" }, { ...TRAIT, kind: undefined }, { ...TRAIT, kind: 1 },
      { ...TRAIT, spec: "str" }, { ...TRAIT, spec: null }, { ...TRAIT, spec: [] },
      { ...TRAIT, headers: "e1" }, { ...TRAIT, headers: [] }, { ...TRAIT, headers: {} }, { ...TRAIT, headers: { entityId: 5 } },
      { ...TRAIT, headers: { entityId: "" } }, { ...TRAIT, headers: { entityId: "e1", entityVersionId: 3 } },
      { ...TRAIT, headers: { entityId: "e1", entityVersionId: "" } },
    ];
    for (const input of bads) {
      const r = await createTrait(target, input as never, ctx);
      expect(code(r), JSON.stringify(input)).toBe("VALIDATION_ERROR");
    }
    for (const badTarget of [null, undefined, {}, { level: "DOMAIN" }, { level: "TENANT", tenantId: 5 }, { level: "PRODUCT", productId: "" }]) {
      expect(code(await createTrait(badTarget as never, TRAIT, ctx))).toBe("VALIDATION_ERROR");
    }
  });

  it("update / delete / get reject bad ids, owners and input", async () => {
    const ctx = fakeCtx();
    for (const bad of ["", 3, null, undefined]) {
      expect(code(await updateTrait(bad as never, { name: "CE" }, DOMAIN, ctx))).toBe("VALIDATION_ERROR");
      expect(code(await deleteTrait(bad as never, DOMAIN, ctx))).toBe("VALIDATION_ERROR");
      expect(code(await getTrait(bad as never, ctx))).toBe("VALIDATION_ERROR");
    }
    for (const owner of [null, undefined, {}, { level: "DOMAIN", domainId: 1 }]) {
      expect(code(await updateTrait("t1", { name: "CE" }, owner as never, ctx))).toBe("VALIDATION_ERROR");
      expect(code(await deleteTrait("t1", owner as never, ctx))).toBe("VALIDATION_ERROR");
    }
    for (const input of [null, undefined, "x", []]) expect(code(await updateTrait("t1", input as never, DOMAIN, ctx))).toBe("VALIDATION_ERROR");
  });

  it("a throwing pre-write read becomes DB_ERROR (scope, headers pin, row load, get)", async () => {
    const target = DOMAIN;
    // createTrait: scope lookup throws (outside the audited write)
    expect(code(await createTrait(target, TRAIT, fakeCtx({ domain: { findUnique: boom } })))).toBe("DB_ERROR");
    // createTrait: resolvePin throws
    const pinDown = fakeCtx({ domain, entity: { findFirst: boom } });
    expect(code(await createTrait(target, { ...TRAIT, headers: { entityId: "e1" } }, pinDown))).toBe("DB_ERROR");
    // updateTrait / deleteTrait: owner scope or row load throws
    expect(code(await updateTrait("t1", { name: "CE" }, target, fakeCtx({ domain: { findUnique: boom } })))).toBe("DB_ERROR");
    const rowDown = fakeCtx({ domain, trait: { findUnique: boom } });
    expect(code(await updateTrait("t1", { name: "CE" }, target, rowDown))).toBe("DB_ERROR");
    expect(code(await deleteTrait("t1", target, rowDown))).toBe("DB_ERROR");
    expect(code(await getTrait("t1", rowDown))).toBe("DB_ERROR");
    // updateTrait: resolvePin throws after a successful load
    const updatePinDown = fakeCtx({ domain, trait: { findUnique: vi.fn().mockResolvedValue(traitRow) }, entity: { findFirst: boom } });
    expect(code(await updateTrait("t1", { name: "CE", headers: { entityId: "e1" } }, target, updatePinDown))).toBe("DB_ERROR");
  });

  it("does not mask a normal NOT_FOUND / FORBIDDEN as DB_ERROR", async () => {
    const missing = fakeCtx({ domain, trait: { findUnique: vi.fn().mockResolvedValue(null) } });
    expect(code(await getTrait("t1", missing))).toBe("NOT_FOUND");
    expect(code(await deleteTrait("t1", DOMAIN, missing))).toBe("NOT_FOUND");
    const tenantTrait = fakeCtx({ domain, trait: { findUnique: vi.fn().mockResolvedValue({ ...traitRow, domainId: null }) } });
    expect(code(await deleteTrait("t1", DOMAIN, tenantTrait))).toBe("FORBIDDEN");
  });
});

describe("ownership failures never leak the foreign record (the library trait pages make these actions reachable)", () => {
  const SECRET = "secret-foreign-name";
  const hygiene = <T,>(r: Result<T>) => {
    expect(code(r)).toBe("FORBIDDEN");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.success ? undefined : r.error.details).toBeUndefined();
  };

  it("trait writes from another level: FORBIDDEN, no details, labelled by the caller's own trait id", async () => {
    const tenantTrait = fakeCtx({ domain, trait: { findUnique: vi.fn().mockResolvedValue({ ...traitRow, name: SECRET, domainId: null }) } });
    hygiene(await updateTrait("t1", { name: "CE" }, DOMAIN, tenantTrait));
    const deleted = await deleteTrait("t1", DOMAIN, tenantTrait);
    hygiene(deleted);
    expect(message(deleted)).toContain('Trait "t1"');
  });
});
