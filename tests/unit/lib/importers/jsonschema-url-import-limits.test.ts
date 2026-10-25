import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ctx: vi.fn() }));
vi.mock("@/lib/action-context", () => ({
  getActionContext: h.ctx,
  sanitizeActionError: async (r: unknown) => {
    try {
      return await r;
    } catch {
      return { success: false, error: { code: "INTERNAL_ERROR", message: "generic" } };
    }
  },
}));

import { ImportLimiter } from "@/lib/importers/import-limiter";
import { resolveJsonSchemaRefs } from "@/lib/importers/jsonschema-ref-resolver";
import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";
import { MAX_ORIGINAL_CONTENT_TOTAL } from "@/lib/importers/jsonschema.importer";
import { runJsonSchemaUrlImport } from "@/app/(dashboard)/schemas/[domainSlug]/jsonschema-url-import-core";

const PUBLIC = async () => ["93.184.216.34"];
const BASE = "https://example.com/schemas";
const json = (o: unknown) => JSON.stringify(o);

/** A fetcher whose responses are held until the test lets them go, so an import can be observed while it is running. */
function gated(files: Record<string, string>) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return {
    open: () => open(),
    deps: {
      lookup: PUBLIC,
      fetchHttp: async (url: string) => {
        await gate;
        if (url in files) return files[url]!;
        throw new Error("HTTP 404");
      },
    },
  };
}

const served = { [`${BASE}/root.json`]: json({ title: "Root", type: "object", properties: { a: { type: "string" } } }) };

describe("URL import: process-wide concurrency and a per-user rate limit", () => {
  beforeEach(() => h.ctx.mockReset());

  it("refuses a third concurrent import with a 'busy, retry' error, and accepts again once one has finished", async () => {
    h.ctx.mockImplementation(async () => ({ userId: "u" }));
    const limiter = new ImportLimiter({ maxConcurrent: 2, perUserLimit: 100 });
    const g = gated(served);
    const first = runJsonSchemaUrlImport(`${BASE}/root.json`, g.deps, { limiter });
    const second = runJsonSchemaUrlImport(`${BASE}/root.json`, g.deps, { limiter });
    // let both reach the fetch (they hold their slots there)
    await vi.waitFor(() => expect(limiter.active).toBe(2));
    const third = await runJsonSchemaUrlImport(`${BASE}/root.json`, g.deps, { limiter });
    expect(third).toMatchObject({ success: false, error: { code: "IMPORT_BUSY" } });
    expect(!third.success && third.error.message).toMatch(/busy/i);
    expect(!third.success && third.error.suggestedFix).toMatch(/try again/i);
    g.open();
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
    expect(limiter.active).toBe(0);
    const fourth = await runJsonSchemaUrlImport(`${BASE}/root.json`, { lookup: PUBLIC, fetchHttp: async (u) => served[u as keyof typeof served]! }, { limiter });
    expect(fourth.success).toBe(true);
  });

  it("a failed import releases its slot", async () => {
    h.ctx.mockResolvedValue({ userId: "u" });
    const limiter = new ImportLimiter({ maxConcurrent: 1, perUserLimit: 100 });
    const failing = { lookup: PUBLIC, fetchHttp: async () => { throw new Error("HTTP 500"); } };
    for (let i = 0; i < 3; i++) {
      const r = await runJsonSchemaUrlImport(`${BASE}/root.json`, failing, { limiter });
      expect(r).toMatchObject({ success: false });
      expect(!r.success && r.error.code).not.toBe("IMPORT_BUSY");
    }
    expect(limiter.active).toBe(0);
  });

  it("limits one user's starts per window with the time to wait, and another user is not affected", async () => {
    let now = 5_000_000;
    const limiter = new ImportLimiter({ maxConcurrent: 10, perUserLimit: 3, windowMs: 60_000, now: () => now });
    const deps = { lookup: PUBLIC, fetchHttp: async (u: string) => served[u as keyof typeof served]! };
    h.ctx.mockResolvedValue({ userId: "u1" });
    for (let i = 0; i < 3; i++) expect((await runJsonSchemaUrlImport(`${BASE}/root.json`, deps, { limiter })).success).toBe(true);
    const refused = await runJsonSchemaUrlImport(`${BASE}/root.json`, deps, { limiter });
    expect(refused).toMatchObject({ success: false, error: { code: "RATE_LIMITED" } });
    expect(!refused.success && refused.error.message).toMatch(/60 seconds/);
    h.ctx.mockResolvedValue({ userId: "u2" });
    expect((await runJsonSchemaUrlImport(`${BASE}/root.json`, deps, { limiter })).success).toBe(true);
    h.ctx.mockResolvedValue({ userId: "u1" });
    now += 60_001;
    expect((await runJsonSchemaUrlImport(`${BASE}/root.json`, deps, { limiter })).success).toBe(true);
  });

  it("an unauthenticated call or an invalid URL never takes a slot or a place in the window", async () => {
    const limiter = new ImportLimiter({ maxConcurrent: 1, perUserLimit: 1 });
    h.ctx.mockResolvedValue(null);
    expect(await runJsonSchemaUrlImport(`${BASE}/root.json`, undefined, { limiter })).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    h.ctx.mockResolvedValue({ userId: "u" });
    for (const bad of ["", "   ", `https://example.com/${"a".repeat(3000)}.json`]) {
      expect(await runJsonSchemaUrlImport(bad, undefined, { limiter })).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
    const deps = { lookup: PUBLIC, fetchHttp: async (u: string) => served[u as keyof typeof served]! };
    expect((await runJsonSchemaUrlImport(`${BASE}/root.json`, deps, { limiter })).success).toBe(true);
  });

  it("the default limiter (no injection) is process-wide and still lets ordinary use through", async () => {
    h.ctx.mockResolvedValue({ userId: "default-limiter-user" });
    const deps = { lookup: PUBLIC, fetchHttp: async (u: string) => served[u as keyof typeof served]! };
    expect((await runJsonSchemaUrlImport(`${BASE}/root.json`, deps)).success).toBe(true);
  });
});

describe("URL import: bytes", () => {
  it("the total bytes of all fetched documents of one import are capped at 20 MB: later documents are refused with a per-reference reason", async () => {
    const filler = "x".repeat(2_000_000); // under the 2 MiB per-file cap; ten of them fit in 20 MiB, the eleventh does not
    const files: Record<string, string> = {};
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 14; i++) {
      const uri = `${BASE}/f${i}.json`;
      props[`p${i}`] = { $ref: uri };
      files[uri] = json({ title: `F${i}`, type: "object", properties: { a: { type: "string" } }, "x-note": filler });
    }
    const root = json({ title: "Root", type: "object", properties: props });
    const refs = await resolveJsonSchemaRefs(`${BASE}/root.json`, root, {
      lookup: PUBLIC,
      fetchHttp: async (u) => files[u] ?? "{}",
      limits: { maxConcurrent: 1 },
    });
    const total = [...refs.resolved.keys()].filter((k) => k.includes("/f")).length;
    expect(total).toBe(10);
    const refused = [...refs.unreachable.values()].filter((r) => /total size limit exceeded/.test(r));
    expect(refused.length).toBe(14 - total);
  });

  it("the original source text kept on the imported entities is budgeted for a URL import too (first entity of each document only)", async () => {
    const files: Record<string, string> = {};
    const props: Record<string, unknown> = {};
    for (let d = 0; d < 8; d++) {
      const uri = `${BASE}/d${d}.json`;
      props[`d${d}`] = { $ref: uri };
      const defs: Record<string, unknown> = {};
      for (let e = 0; e < 3; e++) defs[`E${d}_${e}`] = { type: "object", properties: { a: { type: "string" } } };
      files[uri] = json({ title: `D${d}`, type: "object", properties: { a: { type: "string" } }, $defs: defs, description: "y".repeat(200_000) });
    }
    files[`${BASE}/root.json`] = json({ title: "Root", type: "object", properties: props });
    const r = await importJsonSchemaFromUrl(`${BASE}/root.json`, { lookup: PUBLIC, fetchHttp: async (u) => files[u] ?? "{}" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const kept = r.data.entities.filter((e) => e.originalContent !== "");
    const keptChars = kept.reduce((n, e) => n + e.originalContent.length, 0);
    expect(r.data.entities.length).toBeGreaterThan(20);
    // one copy per document (9 documents), never one per entity
    expect(kept.length).toBeLessThanOrEqual(9);
    expect(keptChars).toBeLessThan(MAX_ORIGINAL_CONTENT_TOTAL + 2_000_000);
    expect(r.data.warnings.some((w) => /original source text is kept on the first entity of each document only/.test(w))).toBe(true);
  });
});
