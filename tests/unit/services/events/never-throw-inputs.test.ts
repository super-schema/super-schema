import { describe, it, expect, vi } from "vitest";

// withAudit only runs the callback here; the real one needs the app's Prisma singleton.
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: async ({ fn }: { fn: () => Promise<unknown> }) => fn(), AuditUserMissingError };
});

import type { PrismaClient } from "@/generated/prisma/client";
import { createEvent, renameEvent } from "@/services/events/event.service";
import { normalizeCatalogName, normalizeProtocol } from "@/lib/events/inputs";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

/** A Prisma stand-in: any model not given in `models` throws if touched (validation must stop before any query). */
function ctxOf(models: Record<string, Record<string, unknown>> = {}): ServiceContext {
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
const asAny = (v: unknown) => v as never;

const BAD_IDS: unknown[] = [{}, 123, null, undefined, "", "   ", [], ["p1"], true];
const NO_PRODUCT = { findUnique: vi.fn().mockResolvedValue(null) };
const OWNER = { level: "PRODUCT", productId: "p1" } as const;

describe("createEvent never throws on a malformed product scope", () => {
  it("an unknown product id is NOT_FOUND", async () => {
    const r = await createEvent("nope", { name: "Orders" }, ctxOf({ product: NO_PRODUCT }));
    expect(code(r)).toBe("NOT_FOUND");
  });

  it("a database throw while resolving the scope is a generic DB_ERROR (no driver text)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const product = { findUnique: vi.fn().mockRejectedValue(new Error("Invalid `prisma.product.findUnique()` invocation: relation \"products\" does not exist")) };
    const r = await createEvent("p1", { name: "Orders" }, ctxOf({ product }));
    expect(code(r)).toBe("DB_ERROR");
    expect(message(r)).toBe(GENERIC_ACTION_ERROR);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("createEvent never throws on malformed input", () => {
  it.each([123, null, undefined, {}, [], true, ""])("name %j -> VALIDATION_ERROR", async (name) => {
    const r = await createEvent("p1", asAny({ name }), ctxOf());
    expect(code(r)).toBe("VALIDATION_ERROR");
  });

  it.each([null, undefined, "x", 5, [], true])("input %j -> VALIDATION_ERROR (not a TypeError)", async (input) => {
    expect(code(await createEvent("p1", asAny(input), ctxOf()))).toBe("VALIDATION_ERROR");
  });

  it("a non-string title / description -> VALIDATION_ERROR", async () => {
    expect(code(await createEvent("p1", asAny({ name: "Orders", title: 5 }), ctxOf()))).toBe("VALIDATION_ERROR");
    expect(code(await createEvent("p1", asAny({ name: "Orders", description: {} }), ctxOf()))).toBe("VALIDATION_ERROR");
  });

  it.each(BAD_IDS.map((v) => [JSON.stringify(v) ?? String(v), v] as const))("productId %s -> VALIDATION_ERROR (not a mislabelled, logged DB_ERROR)", async (_label, bad) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await createEvent(asAny(bad), { name: "Orders" }, ctxOf());
    expect(code(r)).toBe("VALIDATION_ERROR");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("an unknown product id is NOT_FOUND, not DB_ERROR", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await createEvent("nope", { name: "Orders" }, ctxOf({ product: NO_PRODUCT }));
    expect(code(r)).toBe("NOT_FOUND");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("renameEvent never throws on a malformed name", () => {
  it.each([123, null, undefined, {}, [], true])("name %j -> VALIDATION_ERROR before any query", async (name) => {
    expect(code(await renameEvent("s1", name, OWNER, ctxOf()))).toBe("VALIDATION_ERROR");
  });
});

describe("normalizeCatalogName / normalizeProtocol type-check their input", () => {
  it.each([123, null, undefined, {}, [], true])("normalizeCatalogName(%j) is a VALIDATION_ERROR, not a TypeError", (raw) => {
    const r = normalizeCatalogName(raw, "Event");
    expect(code(r)).toBe("VALIDATION_ERROR");
    expect(message(r)).toBe("Event name must be a string");
  });

  it.each([123, null, undefined, {}, [], true])("normalizeProtocol(%j) is a VALIDATION_ERROR, not a TypeError", (raw) => {
    expect(code(normalizeProtocol(raw))).toBe("VALIDATION_ERROR");
  });

  it("strings behave as before (trimmed, pattern-checked)", () => {
    expect(normalizeCatalogName("  Order.Created ", "Event")).toEqual({ success: true, data: "Order.Created" });
    expect(code(normalizeCatalogName("a b", "Event"))).toBe("VALIDATION_ERROR");
    expect(normalizeProtocol(" Kafka ")).toEqual({ success: true, data: "kafka" });
  });
});
