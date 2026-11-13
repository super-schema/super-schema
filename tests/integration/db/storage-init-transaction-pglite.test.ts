// @vitest-environment node
/**
 * src/lib/db-storage-init.ts (used by src/lib/db.ts): the one-time legacy-storage initialization runs on the raw client before the first
 * query. When the process's first operation is an interactive transaction (the login throttle is one), the query hook used to start the
 * initialization from INSIDE the transaction: on PGlite's single connection the initialization waited for the transaction and the
 * transaction waited for the initialization, until Prisma's timeout (P2028), so the first sign-in after every restart failed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { initializeLegacyTenantStorage } from "@/lib/gitops/tenant-mode";
import { withStorageInitialization } from "@/lib/db-storage-init";
import type { TestDb } from "../../helpers/pglite-db";

let db: TestDb;
beforeAll(async () => {
  db = await (await import("../../helpers/pglite-db")).createPgliteDb();
}, 60_000);
afterAll(async () => {
  await db?.close();
});

describe("withStorageInitialization", () => {
  it("lets an interactive transaction be the very first operation without deadlocking", async () => {
    const raw = db.prisma;
    let initialized = 0;
    const client = withStorageInitialization(raw, async () => {
      initialized++;
      await initializeLegacyTenantStorage(raw);
    }) as unknown as PrismaClient;

    const tenants = await client.$transaction(async (tx) => tx.tenant.findMany(), { timeout: 3_000, maxWait: 3_000 });

    expect(Array.isArray(tenants)).toBe(true);
    expect(initialized).toBe(1);
  }, 20_000);

  it("initializes once for plain queries too", async () => {
    let initialized = 0;
    const client = withStorageInitialization(db.prisma, async () => {
      initialized++;
    }) as unknown as PrismaClient;
    await client.tenant.findMany();
    await client.tenant.findMany();
    expect(initialized).toBe(1);
  });
});
