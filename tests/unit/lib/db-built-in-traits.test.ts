import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@/types/result";

// The built-in message properties step (src/lib/db-built-in-traits.ts, the last step of scripts/db.ts). `strict` is `npm run db:deploy`, the
// production step: a failure must fail it, because an app that starts without its built-in traits is what the step exists to prevent.
// Not strict is `ensure` (before `npm run dev`): a failure is one line and the start goes on.

const h = vi.hoisted(() => ({
  ensureBundledTraitsForAllTenants: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@/services/events/bundled-traits.service", () => ({ ensureBundledTraitsForAllTenants: h.ensureBundledTraitsForAllTenants }));
vi.mock("@/generated/prisma/client", () => ({
  PrismaClient: class {
    $disconnect = h.disconnect;
  },
}));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class {} }));

import { installBuiltInTraits } from "@/lib/db-built-in-traits";

const DATABASE_URL = "postgresql://superschema:test@127.0.0.1:1/superschema";
const saved = { DB_PROVIDER: process.env.DB_PROVIDER, DATABASE_URL: process.env.DATABASE_URL };

/** What ensureBundledTraitsForAllTenants returns for a run over two tenants, with the given failed and skipped tenants. */
function ran(failed: Array<{ tenantId: string; code: string }> = [], skipped: Array<{ tenantId: string; names: string[] }> = []) {
  return ok({ tenants: 2, created: [{ tenantId: "tenant_default", names: ["CloudEvents", "TraceContext"] }], skipped, failed });
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.DB_PROVIDER = "postgresql";
  process.env.DATABASE_URL = DATABASE_URL;
  h.ensureBundledTraitsForAllTenants.mockReset();
  h.disconnect.mockReset();
  h.disconnect.mockResolvedValue(undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  log.mockRestore();
  for (const name of ["DB_PROVIDER", "DATABASE_URL"] as const) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("installBuiltInTraits: deploy (strict, the production step)", () => {
  it("resolves when every tenant has the built-in message properties, and closes its connection", async () => {
    h.ensureBundledTraitsForAllTenants.mockResolvedValue(ran());
    await expect(installBuiltInTraits({ strict: true })).resolves.toBeUndefined();
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });

  it("fails when a tenant could not be given them, so the app never starts without them", async () => {
    h.ensureBundledTraitsForAllTenants.mockResolvedValue(ran([{ tenantId: "tenant_acme", code: "DB_ERROR" }]));
    await expect(installBuiltInTraits({ strict: true })).rejects.toThrow("tenant_acme");
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });

  it("fails when the tenants cannot be listed", async () => {
    h.ensureBundledTraitsForAllTenants.mockResolvedValue(err({ code: "DB_ERROR", message: 'relation "tenants" does not exist' }));
    await expect(installBuiltInTraits({ strict: true })).rejects.toThrow("DB_ERROR");
  });

  it("fails with the reason when the install throws (no connection)", async () => {
    h.ensureBundledTraitsForAllTenants.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1"));
    await expect(installBuiltInTraits({ strict: true })).rejects.toThrow("ECONNREFUSED");
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });

  it("prints the database error the services logged, in full, before it fails, and gives the console back", async () => {
    const dbError = new Error('relation "traits" does not exist');
    h.ensureBundledTraitsForAllTenants.mockImplementation(async () => {
      console.error(dbError); // what the services do on a database failure (dbErrorResult)
      return err({ code: "DB_ERROR", message: "relation does not exist" });
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(installBuiltInTraits({ strict: true })).rejects.toThrow("DB_ERROR");
    expect(error).toHaveBeenCalledWith(dbError);
    expect(console.error).toBe(error);
    error.mockRestore();
  });

  it("does not fail for a name that something else holds in a tenant: that is reported and left alone", async () => {
    h.ensureBundledTraitsForAllTenants.mockResolvedValue(ran([], [{ tenantId: "tenant_acme", names: ["CloudEvents"] }]));
    await expect(installBuiltInTraits({ strict: true })).resolves.toBeUndefined();
  });

  it("fails on PostgreSQL without a DATABASE_URL, before it installs anything", async () => {
    delete process.env.DATABASE_URL;
    await expect(installBuiltInTraits({ strict: true })).rejects.toThrow("DATABASE_URL is not set");
    expect(h.ensureBundledTraitsForAllTenants).not.toHaveBeenCalled();
  });
});

describe("installBuiltInTraits: ensure (not strict, before npm run dev)", () => {
  it("a tenant that could not be given them is one log line, and the start goes on", async () => {
    h.ensureBundledTraitsForAllTenants.mockResolvedValue(ran([{ tenantId: "tenant_acme", code: "DB_ERROR" }]));
    await expect(installBuiltInTraits({ strict: false })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("failed for tenant_acme (DB_ERROR)"));
  });

  it("a database that cannot be reached is one warning, and the start goes on", async () => {
    h.ensureBundledTraitsForAllTenants.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(installBuiltInTraits({ strict: false })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[db] built-in message properties: skipped (connect ECONNREFUSED 127.0.0.1:1).");
    warn.mockRestore();
  });
});
