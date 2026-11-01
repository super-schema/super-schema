import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { $RefParser } from "@apidevtools/json-schema-ref-parser";
import {
  createDefaultFetchHttp,
  createGhFetchGitFile,
  resolveJsonSchemaRefs,
  type ResolverDeps,
} from "@/lib/importers/jsonschema-ref-resolver";
import { checkHttpsUrl } from "@/lib/importers/jsonschema-ref-security";

const PUBLIC = async () => ["93.184.216.34"];
const json = (o: unknown) => JSON.stringify(o);
const ROOT = "https://example.com/schemas/root.json";

function mk(files: Record<string, string>, extra: Partial<ResolverDeps> = {}) {
  const http: string[] = [];
  const git: string[][] = [];
  const deps: ResolverDeps = {
    lookup: PUBLIC,
    // These tests are about the organization rule, not about which repositories the server may read (jsonschema-ref-repo-scope.test.ts).
    gitImportConfig: { mode: "any" },
    fetchHttp: async (u) => {
      http.push(u);
      if (u in files) return files[u]!;
      throw new Error("HTTP 404");
    },
    fetchGitFile: async (host, owner, repo, ref, path) => {
      git.push([host, owner, repo, ref, path]);
      if (path in files) return files[path]!;
      throw new Error("HTTP 404");
    },
    ...extra,
  };
  return { deps, http, git };
}

describe("Important 1: one malformed $ref does not abort the rest", () => {
  it("keeps ok.json and ok2.json and records the bad ref", async () => {
    const { deps } = mk({
      "https://example.com/schemas/ok.json": json({ type: "string" }),
      "https://example.com/schemas/ok2.json": json({ type: "integer" }),
    });
    const root = '{"a":{"$ref":"./ok.json"},"b":{"$ref":"https://[bad"},"c":{"$ref":"./ok2.json"}}';
    const r = await resolveJsonSchemaRefs(ROOT, root, deps);
    expect(r.resolved.get("https://example.com/schemas/ok.json")).toEqual({ type: "string" });
    expect(r.resolved.get("https://example.com/schemas/ok2.json")).toEqual({ type: "integer" });
    expect(r.unreachable.get("https://[bad")).toBe("invalid $ref");
    // the caller's root document is returned unmodified
    expect((r.resolved.get(ROOT) as { b: { $ref: string } }).b.$ref).toBe("https://[bad");
  });

  it("also isolates a malformed ref inside a fetched document", async () => {
    const { deps } = mk({
      "https://example.com/schemas/mid.json": json({ x: { $ref: "https://[bad2" }, y: { $ref: "leaf.json" } }),
      "https://example.com/schemas/leaf.json": json({ leaf: true }),
    });
    const r = await resolveJsonSchemaRefs(ROOT, json({ m: { $ref: "mid.json" }, l: { $ref: "other.json" } }), deps);
    expect(r.resolved.has("https://example.com/schemas/leaf.json")).toBe(true);
    expect(r.unreachable.get("https://[bad2")).toBe("invalid $ref");
    expect(r.unreachable.has("https://example.com/schemas/other.json")).toBe(true);
  });
});

describe("Important 2: git fetches are scoped to the root's organization", () => {
  const PP = "https://github.example.com/Acme/repoA/blob/master/d/root.json";
  const ref = (u: string) => json({ a: { $ref: u } });

  it("allows another repo of the same owner", async () => {
    const { deps, git } = mk({ "z/x.json": json({ ok: 1 }) });
    const r = await resolveJsonSchemaRefs(PP, ref("https://github.example.com/Acme/repoB/blob/main/z/x.json"), deps);
    expect(git).toEqual([["github.example.com", "Acme", "repoB", "main", "z/x.json"]]);
    expect(r.resolved.size).toBe(2);
  });

  it("refuses another owner with the documented reason and zero gh calls", async () => {
    const { deps, git } = mk({ "z/x.json": json({ ok: 1 }) });
    const u = "https://github.example.com/OtherOrg/repoB/blob/main/z/x.json";
    const r = await resolveJsonSchemaRefs(PP, ref(u), deps);
    expect(git).toHaveLength(0);
    expect(r.unreachable.get(u)).toBe("outside the root document's organization; not fetched");
  });

  it("extraGitScopes (host/owner and host/owner/repo) opt in", async () => {
    const u = "https://github.example.com/OtherOrg/repoB/blob/main/z/x.json";
    for (const scope of ["github.example.com/OtherOrg", "github.example.com/OtherOrg/repoB"]) {
      const { deps, git } = mk({ "z/x.json": json({ ok: 1 }) }, { extraGitScopes: [scope] });
      await resolveJsonSchemaRefs(PP, ref(u), deps);
      expect(git).toHaveLength(1);
    }
    const { deps, git } = mk({}, { extraGitScopes: ["github.example.com/OtherOrg/repoC"] });
    await resolveJsonSchemaRefs(PP, ref(u), deps);
    expect(git).toHaveLength(0);
  });

  it("a plain-https root never triggers gh", async () => {
    const { deps, git, http } = mk({});
    const r = await resolveJsonSchemaRefs(ROOT, ref("https://github.example.com/o/r/blob/m/a.json"), deps);
    expect(git).toHaveLength(0);
    expect(http).toHaveLength(0);
    expect([...r.unreachable.values()][0]).toMatch(/outside the root document's organization/);
  });

  it.each(["https://github.example.com.evil.com/o/r/blob/m/a.json", "https://github.example.com./Acme/r/blob/m/a.json"])(
    "lookalike host %s takes the plain https path with zero gh calls",
    async (u) => {
      const { deps, git, http } = mk({});
      await resolveJsonSchemaRefs(PP, ref(u), deps);
      expect(git).toHaveLength(0);
      expect(http).toEqual([u]);
    },
  );
});

describe("Important 3: bounded DNS and file work", () => {
  const hostsRoot = (n: number) =>
    json({ properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { $ref: `https://h${i}.example.com/s.json` }])) });

  it("5000 distinct hosts under a low maxFiles make only that many DNS lookups", async () => {
    const lookup = vi.fn(PUBLIC);
    const { deps } = mk({}, { lookup, limits: { maxFiles: 5 } });
    const t = Date.now();
    const r = await resolveJsonSchemaRefs(ROOT, hostsRoot(5000), deps);
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(5);
    expect(Date.now() - t).toBeLessThan(5000);
    expect([...r.unreachable.values()].some((v) => /file limit/.test(v))).toBe(true);
  });

  it("caps distinct hostnames looked up", async () => {
    const lookup = vi.fn(PUBLIC);
    const { deps } = mk({}, { lookup, limits: { maxDnsHosts: 7 } });
    const r = await resolveJsonSchemaRefs(ROOT, hostsRoot(60), deps);
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(7);
    expect([...r.unreachable.values()].some((v) => /distinct host limit/.test(v))).toBe(true);
  });

  it("default cap is 20 hosts", async () => {
    const lookup = vi.fn(PUBLIC);
    const { deps } = mk({}, { lookup });
    await resolveJsonSchemaRefs(ROOT, hostsRoot(60), deps);
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

describe("never throws on odd input", () => {
  it.each([
    ["empty strings", "", ""],
    ["non-string content", ROOT, 123 as unknown as string],
    ["undefined content", ROOT, undefined as unknown as string],
    ["non-string url", 5 as unknown as string, "{}"],
    ["object content", ROOT, {} as unknown as string],
  ])("%s", async (_n, url, content) => {
    const r = await resolveJsonSchemaRefs(url, content, mk({}).deps);
    expect(r.unreachable.size).toBeGreaterThan(0);
    expect(r.resolved.size).toBe(0);
  });

  it("10 MB root is rejected by size", async () => {
    const r = await resolveJsonSchemaRefs(ROOT, " ".repeat(10 * 1024 * 1024) + "{}", mk({}).deps);
    expect(r.unreachable.get(ROOT)).toMatch(/size limit/);
  });

  it("a deps value that throws synchronously becomes an unreachable entry", async () => {
    const deps = { internalGitHosts: 5 } as unknown as ResolverDeps;
    const r = await resolveJsonSchemaRefs(ROOT, json({ a: 1 }), deps);
    expect(r.unreachable.size).toBe(1);
  });

  it("returned maps are copies: late work cannot mutate them", async () => {
    const { deps } = mk({}, {
      fetchHttp: () => new Promise((res) => setTimeout(() => res('{"a":1}'), 150)),
      limits: { overallTimeoutMs: 30 },
    });
    const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: "x.json" } }), deps);
    const snap = JSON.stringify([[...r.resolved.keys()], [...r.unreachable]]);
    await new Promise((res) => setTimeout(res, 300));
    expect(JSON.stringify([[...r.resolved.keys()], [...r.unreachable]])).toBe(snap);
  });
});

describe("redirects compare host including port", () => {
  it("refuses a same-hostname redirect to another port", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://example.com:8443/x.json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(createDefaultFetchHttp({}, PUBLIC)("https://example.com/a.json")).rejects.toThrow(/different host/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("gh failure reasons", () => {
  it("maxBuffer overflow (which also sets killed) is a size error, not a timeout", async () => {
    const f = createGhFetchGitFile(async () => {
      throw Object.assign(new Error("stdout maxBuffer length exceeded"), { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    });
    await expect(f("github.example.com", "o", "r", "m", "a.json")).rejects.toThrow(/size limit/);
  });
});

describe("test-gap pins", () => {
  it("https://127.0.0.1#@good.com/ is blocked (fragment, not credentials)", async () => {
    expect(checkHttpsUrl("https://127.0.0.1#@good.com/").ok).toBe(false);
    const { deps, http } = mk({});
    const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: "https://127.0.0.1#@good.com/" } }), deps);
    expect(http).toHaveLength(0);
    expect(r.unreachable.size).toBe(1);
  });

  it.each(["ftp://example.com/x", "http://example.com/x", "data:application/json,{}", "gopher://example.com/x"])(
    "the resolver's own scheme guard (not checkHttpsUrl) refuses %s before any fetch",
    async (u) => {
      const { deps, http, git } = mk({});
      const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: u } }), deps);
      expect(http).toHaveLength(0);
      expect(git).toHaveLength(0);
      expect([...r.unreachable.values()][0]).toContain("blocked before any fetch");
    },
  );
});

describe("contract with @apidevtools/json-schema-ref-parser", () => {
  it("calls a custom resolver with encoded FileInfo.url and the raw $ref as FileInfo.reference", async () => {
    const version = (JSON.parse(readFileSync(join(process.cwd(), "node_modules/@apidevtools/json-schema-ref-parser/package.json"), "utf8")) as { version: string }).version;
    const seen: Array<{ url: string; reference?: string }> = [];
    const plugin = {
      order: 1,
      canRead: () => true,
      read: (f: { url: string; reference?: string }) => {
        seen.push({ url: f.url, reference: f.reference });
        return f.url.endsWith("b%20c.json") ? '{"leaf":true,"back":{"$ref":"root.json"}}' : "{}";
      },
    };
    const parser = new $RefParser();
    await parser.resolve(
      "https://example.com/d/root.json",
      { a: { $ref: "./b c.json" } } as never,
      { continueOnError: true, resolve: { external: true, file: false, http: false, plugin } } as never,
    );
    const msg =
      `ref-parser ${version} changed the resolver contract (FileInfo.url / FileInfo.reference, ` +
      `resolve option plugin keys, cycle handling). Update src/lib/importers/jsonschema-ref-resolver.ts.`;
    expect(seen, msg).toEqual([{ url: "https://example.com/d/b%20c.json", reference: "./b c.json" }]);
  });
});
