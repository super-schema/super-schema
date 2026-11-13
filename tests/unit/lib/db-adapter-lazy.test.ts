/**
 * src/lib/db-adapter.ts: building the PGlite adapter must NOT open the data directory. `src/lib/db.ts` builds its Prisma client at import time,
 * and Next's dev server imports server modules in short-lived worker processes (`jest-worker/processChild.js`) while it compiles routes. An
 * eager open made every such worker open ./data/pglite next to the dev server ("The PGlite database ... could not be opened (Aborted())", and
 * two writers on one directory). The directory is opened only when Prisma connects, i.e. on the first query.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbAdapter } from "../../../src/lib/db-adapter";
import { closeSharedPglite } from "../../../src/lib/pglite-open";

const REGISTRY = Symbol.for("super-schema.pglite.clients");
const openClients = () => (globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>)[REGISTRY] ?? new Map();

describe("createDbAdapter (pglite)", () => {
  let dir: string;
  const saved = { provider: process.env.DB_PROVIDER, dataDir: process.env.PGLITE_DATA_DIR };

  beforeEach(async () => {
    await closeSharedPglite();
    dir = path.join(mkdtempSync(path.join(tmpdir(), "db-adapter-lazy-")), "pglite");
    process.env.DB_PROVIDER = "pglite";
    process.env.PGLITE_DATA_DIR = dir;
  });

  afterEach(async () => {
    await closeSharedPglite();
    process.env.DB_PROVIDER = saved.provider;
    process.env.PGLITE_DATA_DIR = saved.dataDir;
  });

  it("does not open the data directory when the adapter is built", () => {
    createDbAdapter();
    expect(openClients().has(dir)).toBe(false);
  });

  it("opens the shared client for the directory when Prisma connects", async () => {
    const adapter = createDbAdapter();
    const connection = await adapter.connect();
    expect(openClients().has(dir)).toBe(true);
    await connection.dispose();
  });
});
