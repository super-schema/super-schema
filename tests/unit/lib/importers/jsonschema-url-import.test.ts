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

import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";
import type { MultiEntityImportResult } from "@/lib/importers/types";
import type { ResolverDeps } from "@/lib/importers/jsonschema-ref-resolver";
import { runJsonSchemaUrlImport } from "@/app/(dashboard)/schemas/[domainSlug]/jsonschema-url-import-core";

const PUBLIC = async () => ["93.184.216.34"];
const json = (o: unknown) => JSON.stringify(o);

function httpDeps(files: Record<string, string>): ResolverDeps {
  return {
    lookup: PUBLIC,
    fetchHttp: async (url) => {
      if (url in files) return files[url]!;
      throw new Error("HTTP 404");
    },
    fetchGitFile: async () => {
      throw new Error("git must not be called");
    },
  };
}

const BASE = "https://example.com/schemas";

function setup(files: Record<string, string>, rootPath: string) {
  return { url: `${BASE}/${rootPath}`, deps: httpDeps(files) };
}

const entity = (d: MultiEntityImportResult, name: string) => d.entities.find((e) => e.name === name)!;
const field = (e: { fields: { name: string }[] }, name: string) => e.fields.find((f) => f.name === name)! as any;

describe("importJsonSchemaFromUrl", () => {
  it("(a) PayPal-shaped set: resolved enums by final name, dangling base recorded", async () => {
    const ROOT =
      "https://github.paypal.com/ApiSpecifications-R/identity.CommonComponentsSpecification/blob/master/v1/schema/json/openapi-3.0/components/schemas/address.json";
    const dir = "v1/schema/json/openapi-3.0/components/schemas/";
    const served: Record<string, string> = {
      [`${dir}address.json`]: json({
        allOf: [
          { $ref: "../../common_components/schemas/address_portable.json" },
          {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              normalization_status: { allOf: [{ $ref: "./address_normalization_status.json" }, { description: "norm" }] },
              tags: { type: "array", items: { $ref: "address_tags_type.json" } },
              confirmation_status: { allOf: [{ $ref: "./address_confirmation_status.json" }, { description: "conf" }] },
            },
          },
        ],
      }),
      [`${dir}address_normalization_status.json`]: json({ type: "string", enum: ["NORMALIZED", "UNNORMALIZED"] }),
      [`${dir}address_tags_type.json`]: json({ type: "string", enum: ["HOME", "WORK"] }),
      [`${dir}address_confirmation_status.json`]: json({ type: "string", enum: ["CONFIRMED", "UNCONFIRMED"] }),
    };
    const r = await importJsonSchemaFromUrl(ROOT, {
      fetchGitFile: async (_h, _o, _r, _ref, path) => {
        if (path in served) return served[path]!;
        throw new Error("HTTP 404");
      },
      fetchHttp: async () => {
        throw new Error("http must not be called");
      },
      lookup: PUBLIC,
    });
    if (!r.success) throw new Error(r.error.message);
    const d = r.data;
    expect(d.rootEntityName).toBe("address");
    expect(d.sourceFormat).toBe("json-schema");
    expect(d.entities.map((e) => e.name)).toEqual(["address"]);
    expect(d.enums.map((e) => e.name).sort()).toEqual([
      "address_confirmation_status",
      "address_normalization_status",
      "address_tags_type",
    ]);
    const addr = entity(d, "address") as any;
    expect(addr.extends).toBe("address_portable");
    expect(field(addr, "normalization_status")).toMatchObject({
      type: "enum",
      enumName: "address_normalization_status",
      enumValues: ["NORMALIZED", "UNNORMALIZED"],
    });
    expect(field(addr, "normalization_status").danglingRef).toBeUndefined();
    expect(field(addr, "tags")).toMatchObject({ type: "array", arrayElementType: "enum", enumName: "address_tags_type" });
    expect(field(addr, "confirmation_status")).toMatchObject({ enumName: "address_confirmation_status" });
    expect(d.warnings.some((w) => /address_portable\.json.*could not be loaded/.test(w))).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/XREF/);
  });

  it("(c) a $ref with a fragment points at that definition's entity", async () => {
    const { url, deps } = setup(
      {
        [`${BASE}/root.json`]: json({ title: "Root", type: "object", properties: { f: { $ref: "./other.json#/$defs/Foo" } } }),
        [`${BASE}/other.json`]: json({
          type: "object",
          properties: { x: { type: "string" } },
          $defs: { Foo: { type: "object", properties: { n: { type: "integer" } } } },
        }),
      },
      "root.json",
    );
    const r = await importJsonSchemaFromUrl(url, deps);
    if (!r.success) throw new Error(r.error.message);
    const f = field(entity(r.data, "Root"), "f");
    expect(f.referencedEntityName).toBe("Foo");
    expect(f.danglingRef).toBeUndefined();
    expect(r.data.entities.map((e) => e.name)).toEqual(expect.arrayContaining(["Root", "other", "Foo"]));
  });
});

describe("importJsonSchemaFromUrl (multi-file behaviour)", () => {
  it("(b) name collisions across directories are disambiguated and reported", async () => {
    const { url, deps } = setup(
      {
        [`${BASE}/root.json`]: json({
          title: "Root",
          type: "object",
          properties: { a: { $ref: "./x/status.json" }, b: { $ref: "./y/status.json" } },
        }),
        [`${BASE}/x/status.json`]: json({ type: "string", enum: ["A1"] }),
        [`${BASE}/y/status.json`]: json({ type: "string", enum: ["B1"] }),
      },
      "root.json",
    );
    const r = await importJsonSchemaFromUrl(url, deps);
    if (!r.success) throw new Error(r.error.message);
    const d = r.data;
    expect(d.enums.map((e) => e.name)).toEqual(["status", "status_2"]);
    const root = entity(d, "Root");
    expect(field(root, "a")).toMatchObject({ enumName: "status", enumValues: ["A1"] });
    expect(field(root, "b")).toMatchObject({ enumName: "status_2", enumValues: ["B1"] });
    expect(d.warnings.some((w) => /status_2/.test(w) && /already|collid|renamed/i.test(w))).toBe(true);
  });

  it("(d) a cross-file extends cycle is broken with a warning", async () => {
    const { url, deps } = setup(
      {
        [`${BASE}/A.json`]: json({ title: "A", allOf: [{ $ref: "./B.json" }], properties: { a: { type: "string" } } }),
        [`${BASE}/B.json`]: json({ title: "B", allOf: [{ $ref: "./A.json" }], properties: { b: { type: "string" } } }),
      },
      "A.json",
    );
    const r = await importJsonSchemaFromUrl(url, deps);
    if (!r.success) throw new Error(r.error.message);
    const d = r.data;
    expect(d.entities.map((e) => e.name).sort()).toEqual(["A", "B"]);
    const withExtends = d.entities.filter((e) => e.extends);
    expect(withExtends).toHaveLength(1);
    expect(d.warnings.some((w) => /cycle/i.test(w))).toBe(true);
  });

  it("(e) an unreachable ref yields danglingRef + one warning per distinct target", async () => {
    const { url, deps } = setup(
      {
        [`${BASE}/root.json`]: json({
          title: "Root",
          type: "object",
          properties: {
            a: { $ref: "./missing.json" },
            b: { $ref: "./missing.json" },
            c: { $ref: "./gone.json" },
          },
        }),
      },
      "root.json",
    );
    const r = await importJsonSchemaFromUrl(url, deps);
    if (!r.success) throw new Error(r.error.message);
    const root = entity(r.data, "Root");
    const a = field(root, "a");
    expect(a.referencedEntityName).toBe("missing");
    expect(a.confidence).toBe("low");
    expect(a.originalType).toBe("./missing.json");
    expect(a.danglingRef).toMatchObject({
      ref: "./missing.json",
      resolvedUri: `${BASE}/missing.json`,
      reason: expect.stringMatching(/404/),
    });
    expect(field(root, "c").danglingRef.ref).toBe("./gone.json");
    expect(r.data.warnings.filter((w) => /could not be loaded/.test(w))).toHaveLength(2);
  });

  it("(h) a non-object / unimportable document becomes a warning; the rest still import", async () => {
    const { url, deps } = setup(
      {
        [`${BASE}/root.json`]: json({
          title: "Root",
          type: "object",
          properties: { a: { $ref: "./list.json" }, b: { $ref: "./empty.json" }, c: { $ref: "./ok.json" } },
        }),
        [`${BASE}/list.json`]: json([1, 2]),
        [`${BASE}/empty.json`]: json({ type: "object" }),
        [`${BASE}/ok.json`]: json({ title: "Ok", type: "object", properties: { z: { type: "string" } } }),
      },
      "root.json",
    );
    const r = await importJsonSchemaFromUrl(url, deps);
    if (!r.success) throw new Error(r.error.message);
    expect(r.data.entities.map((e) => e.name)).toEqual(expect.arrayContaining(["Root", "Ok"]));
    expect(field(entity(r.data, "Root"), "c").referencedEntityName).toBe("Ok");
    expect(r.data.warnings.some((w) => /empty\.json/.test(w))).toBe(true);
  });

  it("(g) hundreds of resolved documents with duplicate titles terminate with unique names", async () => {
    const resolved = new Map<string, unknown>();
    resolved.set(`${BASE}/root.json`, { title: "Dup", type: "object", properties: { p: { type: "string" } } });
    for (let i = 0; i < 300; i++) {
      resolved.set(`${BASE}/f${i}.json`, { title: "Dup", type: "object", properties: { p: { type: "string" } } });
    }
    const r = await importJsonSchemaFromUrl(`${BASE}/root.json`, {
      ...httpDeps({ [`${BASE}/root.json`]: json({ title: "Dup", type: "object", properties: { p: { type: "string" } } }) }),
      resolveRefs: async () => ({ resolved, unreachable: new Map() }),
    });
    if (!r.success) throw new Error(r.error.message);
    const names = r.data.entities.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(100);
    expect(names.length).toBeLessThan(302);
    expect(r.data.rootEntityName).toBe("Dup");
  });

  it("fetch failure of the root is an error result, never a throw", async () => {
    const r = await importJsonSchemaFromUrl(`${BASE}/nope.json`, httpDeps({}));
    expect(r.success).toBe(false);
    const bad = await importJsonSchemaFromUrl("http://example.com/x.json", httpDeps({}));
    expect(bad.success).toBe(false);
  });
});

describe("runJsonSchemaUrlImport (action core)", () => {
  beforeEach(() => h.ctx.mockReset());

  const served = {
    [`${BASE}/root.json`]: json({
      title: "Root",
      type: "object",
      properties: { s: { $ref: "./s.json" }, m: { $ref: "./missing.json" } },
    }),
    [`${BASE}/s.json`]: json({ type: "string", enum: ["X"] }),
  };

  it("(f) rejects unauthenticated callers", async () => {
    h.ctx.mockResolvedValue(null);
    const r = await runJsonSchemaUrlImport(`${BASE}/root.json`, setup(served, "root.json").deps);
    expect(r).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
  });

  it("(f) rejects non-string, empty and over-long URLs", async () => {
    h.ctx.mockResolvedValue({ userId: "u" });
    for (const bad of [undefined, 5, {}, "", "   "]) {
      const r = await runJsonSchemaUrlImport(bad as unknown as string);
      expect(r.success).toBe(false);
    }
    const huge = await runJsonSchemaUrlImport(`https://example.com/${"a".repeat(3000)}.json`);
    expect(huge).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("(f) a fake-served import succeeds through toAssetImportResult with the dangling marker kept", async () => {
    h.ctx.mockResolvedValue({ userId: "u" });
    const r = await runJsonSchemaUrlImport(`${BASE}/root.json`, setup(served, "root.json").deps);
    if (!r.success) throw new Error(r.error.message);
    expect(r.data.sourceFormat).toBe("json-schema");
    expect(r.data.sharedEnums.map((e) => e.name)).toEqual(["s"]);
    const root = r.data.models.find((m) => m.name === "Root")!;
    expect((root.fields.find((f) => f.name === "m") as any).danglingRef).toMatchObject({ ref: "./missing.json" });
    expect(r.data.warnings.some((w) => /could not be loaded/.test(w))).toBe(true);
  });

  it("returns a sanitized failure when the orchestration reports one", async () => {
    h.ctx.mockResolvedValue({ userId: "u" });
    const r = await runJsonSchemaUrlImport(`${BASE}/none.json`, httpDeps({}));
    expect(r.success).toBe(false);
  });
});
