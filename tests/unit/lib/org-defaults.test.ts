import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { err, ok } from "@/types/result";

const h = vi.hoisted(() => ({ ensureBundledTraits: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/services/events/bundled-traits.service", () => ({ ensureBundledTraits: h.ensureBundledTraits }));

import { DEFAULT_TENANT_ID, ensureDefaultTenantId } from "@/lib/org-defaults";

/** A client whose tenant table has (or has not) the default tenant; `$transaction` marks it as a full client. */
function client(exists: boolean) {
  const db = {
    $transaction: vi.fn(),
    tenant: {
      findUnique: vi.fn().mockResolvedValue(exists ? { id: DEFAULT_TENANT_ID } : null),
      upsert: vi.fn().mockResolvedValue({ id: DEFAULT_TENANT_ID }),
    },
  };
  return db;
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.ensureBundledTraits.mockReset();
  h.ensureBundledTraits.mockResolvedValue(ok({ created: ["CloudEvents", "TraceContext"], skipped: [] }));
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

describe("ensureDefaultTenantId", () => {
  it("creates the default tenant and installs the built-in message properties in it", async () => {
    const db = client(false);
    expect(await ensureDefaultTenantId(db as unknown as PrismaClient)).toBe(DEFAULT_TENANT_ID);
    expect(db.tenant.upsert).toHaveBeenCalledTimes(1);
    expect(db.tenant.upsert.mock.calls[0][0]).toMatchObject({ where: { id: DEFAULT_TENANT_ID }, create: { id: DEFAULT_TENANT_ID, slug: "default", isSystem: true } });
    expect(h.ensureBundledTraits).toHaveBeenCalledTimes(1);
    expect(h.ensureBundledTraits).toHaveBeenCalledWith(db, DEFAULT_TENANT_ID);
    // the tenant exists before the traits are installed in it
    expect(db.tenant.upsert.mock.invocationCallOrder[0]).toBeLessThan(h.ensureBundledTraits.mock.invocationCallOrder[0]);
  });

  it("leaves an existing tenant alone: one read, no write, nothing installed (the start-up step covers tenants from before)", async () => {
    const db = client(true);
    expect(await ensureDefaultTenantId(db as unknown as PrismaClient)).toBe(DEFAULT_TENANT_ID);
    expect(db.tenant.findUnique).toHaveBeenCalledTimes(1);
    expect(db.tenant.upsert).not.toHaveBeenCalled();
    expect(h.ensureBundledTraits).not.toHaveBeenCalled();
  });

  it("still returns the tenant when installing the built-ins fails with a Result error, and logs it", async () => {
    h.ensureBundledTraits.mockResolvedValue(err({ code: "DB_ERROR", message: "boom" }));
    const db = client(false);
    expect(await ensureDefaultTenantId(db as unknown as PrismaClient)).toBe(DEFAULT_TENANT_ID);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("DB_ERROR"));
  });

  it("still returns the tenant when installing the built-ins throws", async () => {
    h.ensureBundledTraits.mockRejectedValue(new Error("connection lost"));
    const db = client(false);
    expect(await ensureDefaultTenantId(db as unknown as PrismaClient)).toBe(DEFAULT_TENANT_ID);
    expect(consoleError).toHaveBeenCalled();
  });

  it("does not install anything through a transaction client (it cannot open the nested transaction the install needs)", async () => {
    const tx = { tenant: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({ id: DEFAULT_TENANT_ID }) } };
    expect(await ensureDefaultTenantId(tx as never)).toBe(DEFAULT_TENANT_ID);
    expect(tx.tenant.upsert).toHaveBeenCalledTimes(1);
    expect(h.ensureBundledTraits).not.toHaveBeenCalled();
  });

  it("propagates a failure to create the tenant itself", async () => {
    const db = client(false);
    db.tenant.upsert.mockRejectedValue(new Error("no database"));
    await expect(ensureDefaultTenantId(db as unknown as PrismaClient)).rejects.toThrow("no database");
    expect(h.ensureBundledTraits).not.toHaveBeenCalled();
  });
});
