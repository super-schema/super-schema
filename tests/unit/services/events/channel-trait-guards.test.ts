import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// withAudit only runs the callback here; the real one needs the app's Prisma singleton.
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: async ({ fn }: { fn: () => Promise<unknown> }) => fn(), AuditUserMissingError };
});

import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import type { Result } from "@/types/result";
import { createChannel, deleteChannel, getChannel, setChannelMessages, updateChannel } from "@/services/events/channel.service";
import { createTrait, deleteTrait, getTrait, updateTrait } from "@/services/events/trait.service";
import { MAX_ID_LIST, parseIdList, parseScopeTarget } from "@/services/events/service-guards";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

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

const product = { findUnique: vi.fn().mockResolvedValue({ id: "p1", domainId: "d1", domain: { tenantId: "tn" } }) };
const domain = { findUnique: vi.fn().mockResolvedValue({ id: "d1", tenantId: "tn" }) };
const channelRow = { id: "c1", name: "orders", address: null, protocol: "kafka", format: "avro", formatDialect: null, spec: {}, tenantId: "tn", domainId: "d1", productId: "p1", messages: [] };
const traitRow = { id: "t1", name: "CE", kind: "MESSAGE", spec: {}, headersEntityId: null, headersEntityVersionId: null, tenantId: "tn", domainId: "d1", productId: null };

const PRODUCT = { level: "PRODUCT", productId: "p1" } as const;
const DOMAIN = { level: "DOMAIN", domainId: "d1" } as const;
const CHANNEL = { name: "orders", address: "a", protocol: "kafka", format: "avro" };

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

describe("channel service never throws on untrusted input", () => {
  it("createChannel rejects a non-string productId and malformed fields before touching the DB", async () => {
    const ctx = fakeCtx();
    for (const bad of ["", "  ", 7, null, undefined]) expect(code(await createChannel(bad as never, CHANNEL, ctx))).toBe("VALIDATION_ERROR");
    const bads: Array<Record<string, unknown>> = [
      { ...CHANNEL, name: 123 }, { ...CHANNEL, name: null }, { ...CHANNEL, name: undefined }, { ...CHANNEL, name: { a: 1 } },
      { ...CHANNEL, protocol: 5 }, { ...CHANNEL, format: ["avro"] }, { ...CHANNEL, address: 42 }, { ...CHANNEL, address: {} },
      { ...CHANNEL, formatDialect: 7 }, { ...CHANNEL, spec: "not an object" },
    ];
    for (const input of bads) {
      const r = await createChannel("p1", input as never, ctx);
      expect(code(r), JSON.stringify(input)).toBe("VALIDATION_ERROR");
    }
    for (const input of [null, undefined, "x", 5, []]) expect(code(await createChannel("p1", input as never, ctx))).toBe("VALIDATION_ERROR");
    expect(message(await createChannel("p1", { ...CHANNEL, name: 123 } as never, ctx))).toMatch(/name must be a string/);
  });

  it("update / delete / get / setChannelMessages reject bad ids and owners", async () => {
    const ctx = fakeCtx();
    for (const bad of ["", 3, null, undefined]) {
      expect(code(await updateChannel(bad as never, CHANNEL, PRODUCT, ctx))).toBe("VALIDATION_ERROR");
      expect(code(await deleteChannel(bad as never, PRODUCT, ctx))).toBe("VALIDATION_ERROR");
      expect(code(await getChannel(bad as never, ctx))).toBe("VALIDATION_ERROR");
      expect(code(await setChannelMessages(bad as never, [], PRODUCT, ctx))).toBe("VALIDATION_ERROR");
    }
    for (const owner of [null, undefined, {}, { level: "PRODUCT" }, { level: "PRODUCT", productId: 9 }]) {
      expect(code(await updateChannel("c1", CHANNEL, owner as never, ctx))).toBe("VALIDATION_ERROR");
      expect(code(await deleteChannel("c1", owner as never, ctx))).toBe("VALIDATION_ERROR");
      expect(code(await setChannelMessages("c1", [], owner as never, ctx))).toBe("VALIDATION_ERROR");
    }
    expect(code(await updateChannel("c1", { ...CHANNEL, name: 5 } as never, PRODUCT, ctx))).toBe("VALIDATION_ERROR");
  });

  it("setChannelMessages validates messageIds before any DB access (non-array, undefined, non-strings, > 200)", async () => {
    const ctx = fakeCtx();
    for (const bad of [undefined, null, "m1", { 0: "m1" }, 5, [1], [""], [null]]) {
      const r = await setChannelMessages("c1", bad as never, PRODUCT, ctx);
      expect(code(r), JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    const tooMany = Array.from({ length: MAX_ID_LIST + 1 }, (_, i) => `m${i}`);
    const over = await setChannelMessages("c1", tooMany, PRODUCT, ctx);
    expect(code(over)).toBe("VALIDATION_ERROR");
    expect(message(over)).toMatch(/limit is 200/);
  });

  it("setChannelMessages accepts exactly 200 ids (the DB is reached, so the cap is inclusive)", async () => {
    const ctx = fakeCtx({ product: { findUnique: boom } });
    const atCap = Array.from({ length: MAX_ID_LIST }, (_, i) => `m${i}`);
    expect(code(await setChannelMessages("c1", atCap, PRODUCT, ctx))).toBe("DB_ERROR");
  });

  it("a throwing pre-write read becomes DB_ERROR (scope lookup, row load, message lookup, get)", async () => {
    // scope lookup (resolveScope) throws
    const scopeDown = fakeCtx({ product: { findUnique: boom } });
    expect(code(await updateChannel("c1", CHANNEL, PRODUCT, scopeDown))).toBe("DB_ERROR");
    expect(code(await deleteChannel("c1", PRODUCT, scopeDown))).toBe("DB_ERROR");
    expect(code(await setChannelMessages("c1", ["m1"], PRODUCT, scopeDown))).toBe("DB_ERROR");
    // The driver text never leaves the service: the Result is generic and the original is logged server-side.
    const generic = await deleteChannel("c1", PRODUCT, scopeDown);
    expect(message(generic)).toBe(GENERIC_ACTION_ERROR);
    expect(JSON.stringify(generic)).not.toContain("connection lost");
    expect(consoleError).toHaveBeenCalledWith("[guardRead] database error", expect.objectContaining({ message: "connection lost" }));

    // channel row load throws
    const rowDown = fakeCtx({ product, channel: { findUnique: boom } });
    expect(code(await updateChannel("c1", CHANNEL, PRODUCT, rowDown))).toBe("DB_ERROR");
    expect(code(await deleteChannel("c1", PRODUCT, rowDown))).toBe("DB_ERROR");
    expect(code(await getChannel("c1", rowDown))).toBe("DB_ERROR");

    // message validation read throws
    const messagesDown = fakeCtx({ product, channel: { findUnique: vi.fn().mockResolvedValue(channelRow) }, message: { findMany: boom } });
    expect(code(await setChannelMessages("c1", ["m1"], PRODUCT, messagesDown))).toBe("DB_ERROR");

    // create: the scope lookup happens inside the audited write and is mapped there
    expect(code(await createChannel("p1", CHANNEL, scopeDown))).toBe("DB_ERROR");
  });

  it("does not mask a normal NOT_FOUND / FORBIDDEN as DB_ERROR", async () => {
    const missing = fakeCtx({ product, channel: { findUnique: vi.fn().mockResolvedValue(null) } });
    expect(code(await deleteChannel("c1", PRODUCT, missing))).toBe("NOT_FOUND");
    expect(code(await getChannel("c1", missing))).toBe("NOT_FOUND");
    const foreign = fakeCtx({ product: { findUnique: vi.fn().mockResolvedValue({ id: "p2", domainId: "d1", domain: { tenantId: "tn" } }) }, channel: { findUnique: vi.fn().mockResolvedValue(channelRow) } });
    expect(code(await deleteChannel("c1", { level: "PRODUCT", productId: "p2" }, foreign))).toBe("FORBIDDEN");
  });
});

describe("trait service never throws on untrusted input", () => {
  const TRAIT = { name: "CE", kind: "MESSAGE" as const };

  it("createTrait rejects malformed input before touching the DB", async () => {
    const ctx = fakeCtx();
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

describe("ownership failures never leak the foreign record (the Task 15 detail pages make these actions reachable)", () => {
  const SECRET = "secret-foreign-name";
  const hygiene = <T,>(r: Result<T>) => {
    expect(code(r)).toBe("FORBIDDEN");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.success ? undefined : r.error.details).toBeUndefined();
  };

  it("channel writes from another product: FORBIDDEN, no details, labelled by the caller's own channel id", async () => {
    const foreign = fakeCtx({
      product: { findUnique: vi.fn().mockResolvedValue({ id: "p2", domainId: "d1", domain: { tenantId: "tn" } }) },
      channel: { findUnique: vi.fn().mockResolvedValue({ ...channelRow, name: SECRET }) },
    });
    const other = { level: "PRODUCT", productId: "p2" } as const;
    hygiene(await updateChannel("c1", CHANNEL, other, foreign));
    hygiene(await setChannelMessages("c1", [], other, foreign));
    const deleted = await deleteChannel("c1", other, foreign);
    hygiene(deleted);
    expect(message(deleted)).toContain('Channel "c1"');
  });

  it("trait writes from another level: FORBIDDEN, no details, labelled by the caller's own trait id", async () => {
    const tenantTrait = fakeCtx({ domain, trait: { findUnique: vi.fn().mockResolvedValue({ ...traitRow, name: SECRET, domainId: null }) } });
    hygiene(await updateTrait("t1", { name: "CE" }, DOMAIN, tenantTrait));
    const deleted = await deleteTrait("t1", DOMAIN, tenantTrait);
    hygiene(deleted);
    expect(message(deleted)).toContain('Trait "t1"');
  });
});
