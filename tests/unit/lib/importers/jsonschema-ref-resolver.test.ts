import { describe, expect, it, vi } from "vitest";
import {
  createGhFetchGitFile,
  resolveJsonSchemaRefs,
  type ResolverDeps,
} from "@/lib/importers/jsonschema-ref-resolver";

const PUBLIC = async () => ["93.184.216.34"];
const json = (o: unknown) => JSON.stringify(o);

function httpDeps(files: Record<string, string>, extra: Partial<ResolverDeps> = {}) {
  const calls: string[] = [];
  const deps: ResolverDeps = {
    lookup: PUBLIC,
    fetchHttp: async (url) => {
      calls.push(url);
      if (url in files) return files[url]!;
      throw new Error("HTTP 404");
    },
    fetchGitFile: async () => {
      throw new Error("git fetch must not be called");
    },
    ...extra,
  };
  return { deps, calls };
}

const ROOT = "https://example.com/schemas/root.json";

describe("resolveJsonSchemaRefs basics", () => {
  it("(a) resolves a reachable sibling and records an unreachable one without throwing", async () => {
    const { deps, calls } = httpDeps({
      "https://example.com/schemas/sibling.json": json({ type: "string" }),
    });
    const root = json({
      type: "object",
      properties: { a: { $ref: "./sibling.json" }, b: { $ref: "./missing.json" } },
    });
    const r = await resolveJsonSchemaRefs(ROOT, root, deps);
    expect(r.resolved.get(ROOT)).toMatchObject({ type: "object" });
    expect(r.resolved.get("https://example.com/schemas/sibling.json")).toEqual({ type: "string" });
    expect(r.resolved.has("https://example.com/schemas/missing.json")).toBe(false);
    expect(r.unreachable.get("https://example.com/schemas/missing.json")).toMatch(/404/);
    expect(calls).toHaveLength(2);
  });

  it("(b) terminates on an A <-> B cycle and returns each document once", async () => {
    const A = "https://example.com/schemas/a.json";
    const B = "https://example.com/schemas/b.json";
    const { deps, calls } = httpDeps({
      [B]: json({ properties: { back: { $ref: "./a.json" } } }),
    });
    const r = await resolveJsonSchemaRefs(A, json({ properties: { next: { $ref: "./b.json" } } }), deps);
    expect([...r.resolved.keys()].sort()).toEqual([A, B]);
    expect(calls).toEqual([B]);
    expect(r.unreachable.size).toBe(0);
  });

  it("parses YAML documents", async () => {
    const Y = "https://example.com/schemas/y.yaml";
    const { deps } = httpDeps({ [Y]: "type: integer\n" });
    const r = await resolveJsonSchemaRefs(ROOT, "properties:\n  a:\n    $ref: ./y.yaml\n", deps);
    expect(r.resolved.get(Y)).toEqual({ type: "integer" });
  });

  it("marks non-object and unparseable documents unreachable with a reason", async () => {
    const { deps } = httpDeps({
      "https://example.com/schemas/n.json": "42",
      "https://example.com/schemas/bad.json": "{ not json: [",
    });
    const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: "n.json" }, b: { $ref: "bad.json" } }), deps);
    expect(r.unreachable.get("https://example.com/schemas/n.json")).toMatch(/object/i);
    expect(r.unreachable.has("https://example.com/schemas/bad.json")).toBe(true);
    expect(r.resolved.has("https://example.com/schemas/n.json")).toBe(false);
  });

  it("returns the root as unreachable when its own content is invalid", async () => {
    const { deps } = httpDeps({});
    const r = await resolveJsonSchemaRefs(ROOT, "[1,2]", deps);
    expect(r.resolved.size).toBe(0);
    expect(r.unreachable.has(ROOT)).toBe(true);
  });

  it("ignores internal (#) refs", async () => {
    const { deps, calls } = httpDeps({});
    const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: "#/definitions/x" }, definitions: { x: {} } }), deps);
    expect(calls).toHaveLength(0);
    expect(r.unreachable.size).toBe(0);
  });
});

describe("security 1: local filesystem is never read", () => {
  it.each(["file:///etc/passwd", "../../../../etc/passwd", "/etc/passwd", "C:\\Windows\\win.ini"])(
    "refuses %s with an https root",
    async (ref) => {
      const { deps, calls } = httpDeps({});
      const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: ref } }), deps);
      expect(calls.every((c) => c.startsWith("https://"))).toBe(true);
      expect(r.resolved.size).toBe(1);
      expect(r.unreachable.size).toBeGreaterThan(0);
      for (const [k, v] of r.unreachable) {
        expect(k + v).not.toMatch(/\/Users\/|\/home\/|node_modules/);
      }
    },
  );

  it("a file:// ref and a bare relative ref with a non-URL root are unreachable and nothing is read", async () => {
    const fs = await import("node:fs");
    const spy = vi.spyOn(fs.promises, "readFile");
    const { deps, calls } = httpDeps({});
    const r = await resolveJsonSchemaRefs(
      "root.json",
      json({ a: { $ref: "file:///etc/passwd" }, b: { $ref: "sibling.json" }, c: { $ref: "../../etc/passwd" } }),
      deps,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(calls).toHaveLength(0);
    expect(r.unreachable.size).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify([...r.unreachable])).not.toContain(process.cwd());
    expect(r.resolved.size).toBe(1);
  });
});

describe("security 2: only https", () => {
  it.each(["http://example.com/x.json", "ftp://example.com/x.json", "data:application/json,{}", "javascript:alert(1)", "gopher://example.com/1"])(
    "refuses %s and names the scheme",
    async (ref) => {
      const { deps, calls } = httpDeps({});
      const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: ref } }), deps);
      expect(calls).toHaveLength(0);
      const reasons = [...r.unreachable.values()].join("|");
      expect(reasons).toContain(`"${ref.split(":")[0]}"`);
    },
  );
});

describe("security 5: SSRF guard", () => {
  it.each([
    "https://localhost/x.json", "https://api.localhost/x.json", "https://127.0.0.1/x.json", "https://[::1]/x.json",
    "https://10.1.1.1/x.json", "https://172.20.0.1/x.json", "https://192.168.1.1/x.json",
    "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/x.json", "https://[fd00::1]/x.json",
    "https://[fe80::1]/x.json", "https://0.0.0.0/x.json", "https://[::ffff:127.0.0.1]/x.json",
    "https://user:pw@example.com/x.json",
  ])("never fetches %s", async (ref) => {
    const { deps, calls } = httpDeps({});
    const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: ref } }), deps);
    expect(calls).toHaveLength(0);
    expect(r.unreachable.size).toBe(1);
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const { deps, calls } = httpDeps({}, { lookup: async () => ["10.0.0.9"] });
    const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: "https://rebind.example/x.json" } }), deps);
    expect(calls).toHaveLength(0);
    expect([...r.unreachable.values()][0]).toMatch(/blocked/);
  });
});

describe("security 6: limits", () => {
  const many = (n: number) =>
    json({ properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { $ref: `./f${i}.json` }])) });
  const filesFor = (n: number, body = '{"type":"string"}') =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`https://example.com/schemas/f${i}.json`, body]));

  it("caps the number of files", async () => {
    const { deps, calls } = httpDeps(filesFor(10), { limits: { maxFiles: 3 } });
    const r = await resolveJsonSchemaRefs(ROOT, many(10), deps);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(r.resolved.size - 1).toBeLessThanOrEqual(3);
    expect([...r.unreachable.values()].some((v) => /file limit/i.test(v))).toBe(true);
  });

  it("caps bytes per file", async () => {
    const { deps } = httpDeps(filesFor(1, json({ x: "y".repeat(500) })), { limits: { maxFileBytes: 100 } });
    const r = await resolveJsonSchemaRefs(ROOT, many(1), deps);
    expect(r.resolved.has("https://example.com/schemas/f0.json")).toBe(false);
    expect([...r.unreachable.values()][0]).toMatch(/size/i);
  });

  it("caps total bytes", async () => {
    const body = json({ x: "y".repeat(100) });
    const { deps } = httpDeps(filesFor(5, body), { limits: { maxTotalBytes: 250, maxConcurrent: 1 } });
    const r = await resolveJsonSchemaRefs(ROOT, many(5), deps);
    expect(r.resolved.size - 1).toBeLessThan(5);
    expect([...r.unreachable.values()].some((v) => /total/i.test(v))).toBe(true);
  });

  it("times out a single slow fetch without hanging or throwing", async () => {
    const { deps } = httpDeps({}, { fetchHttp: () => new Promise(() => {}), limits: { perFetchTimeoutMs: 30 } });
    const r = await resolveJsonSchemaRefs(ROOT, many(1), deps);
    expect([...r.unreachable.values()][0]).toMatch(/timed out/i);
  });

  it("enforces the overall timeout and returns what it has", async () => {
    const { deps } = httpDeps(filesFor(3), {
      fetchHttp: () => new Promise((res) => setTimeout(() => res('{"a":1}'), 400)),
      limits: { overallTimeoutMs: 50, perFetchTimeoutMs: 5000 },
    });
    const t = Date.now();
    const r = await resolveJsonSchemaRefs(ROOT, many(3), deps);
    expect(Date.now() - t).toBeLessThan(350);
    expect(r.resolved.has(ROOT)).toBe(true);
    expect([...r.unreachable.values()].some((v) => /overall timeout/i.test(v))).toBe(true);
  });

  it("never exceeds maxConcurrent fetches", async () => {
    let active = 0;
    let peak = 0;
    const { deps } = httpDeps({}, {
      fetchHttp: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return '{"a":1}';
      },
      limits: { maxConcurrent: 2 },
    });
    await resolveJsonSchemaRefs(ROOT, many(8), deps);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });
});

describe("security 8: reasons do not leak", () => {
  it("sanitizes thrown errors from fetchers", async () => {
    const { deps } = httpDeps({}, {
      fetchHttp: async () => {
        throw new Error("EACCES /Users/bob/.config/gh/hosts.yml ghp_abcdefghijklmnopqrstuv\n  at stack (/x.js:1:1)");
      },
    });
    const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: "./x.json" } }), deps);
    const reason = [...r.unreachable.values()][0]!;
    expect(reason).not.toContain("/Users");
    expect(reason).not.toContain("ghp_");
    expect(reason).not.toContain("stack");
  });
});

describe("internal git hosts", () => {
  const PP_ROOT =
    "https://github.example.com/Acme/common-components/blob/master/v1/schema/json/openapi-3.0/components/schemas/address.json";
  const PP_DIR = "v1/schema/json/openapi-3.0/components/schemas";

  function gitDeps(files: Record<string, string>) {
    const calls: Array<{ host: string; owner: string; repo: string; ref: string; path: string }> = [];
    const deps: ResolverDeps = {
      lookup: PUBLIC,
      // These tests are about how git URLs are read, not about which repositories may be (jsonschema-ref-repo-scope.test.ts).
      gitImportConfig: { mode: "any" },
      fetchHttp: async () => {
        throw new Error("HTTP 404");
      },
      fetchGitFile: async (host, owner, repo, ref, path) => {
        calls.push({ host, owner, repo, ref, path });
        if (path in files) return files[path]!;
        throw new Error("HTTP 404 Not Found");
      },
    };
    return { deps, calls };
  }

  it("(d) resolves Acme-shaped relative refs against the root file's own coordinates", async () => {
    const { deps, calls } = gitDeps({
      [`${PP_DIR}/address_normalization_status.json`]: json({ enum: ["A"] }),
      [`${PP_DIR}/address_tags_type.json`]: json({ enum: ["B"] }),
    });
    const root = json({
      properties: {
        s: { $ref: "./address_normalization_status.json" },
        t: { $ref: "address_tags_type.json" },
        p: { $ref: "../../common_components/v5/schema/json/openapi-3.0/components/schemas/address/address_portable.json" },
      },
    });
    const r = await resolveJsonSchemaRefs(PP_ROOT, root, deps);
    for (const c of calls) {
      expect(c).toMatchObject({ host: "github.example.com", owner: "Acme", repo: "common-components", ref: "master" });
    }
    const paths = calls.map((c) => c.path).sort();
    // Standard URL resolution: ../../ from .../components/schemas/ lands on .../openapi-3.0/
    const portable = "v1/schema/json/openapi-3.0/common_components/v5/schema/json/openapi-3.0/components/schemas/address/address_portable.json";
    expect(paths).toEqual([`${PP_DIR}/address_normalization_status.json`, `${PP_DIR}/address_tags_type.json`, portable].sort());
    expect(r.resolved.size).toBe(3); // root + 2 siblings
    const blob = (p: string) => `https://github.example.com/Acme/common-components/blob/master/${p}`;
    expect(r.resolved.has(blob(`${PP_DIR}/address_tags_type.json`))).toBe(true);
    expect(r.unreachable.has(blob(portable))).toBe(true);
  });

  it("a relative ref that escapes the repo root is just unreachable, never an abort", async () => {
    const { deps } = gitDeps({ [`${PP_DIR}/ok.json`]: json({ a: 1 }) });
    const root = json({ a: { $ref: "../../../../../../../../../x/y.json" }, b: { $ref: "ok.json" } });
    const r = await resolveJsonSchemaRefs(PP_ROOT, root, deps);
    expect(r.resolved.size).toBe(2);
    expect(r.unreachable.size).toBe(1);
  });

  it("accepts raw and API-style root URLs", async () => {
    const { deps, calls } = gitDeps({ "d/s.json": json({ a: 1 }) });
    await resolveJsonSchemaRefs("https://github.example.com/o/r/raw/main/d/root.json", json({ a: { $ref: "s.json" } }), deps);
    await resolveJsonSchemaRefs("https://github.example.com/api/v3/repos/o/r/contents/d/root.json?ref=dev", json({ a: { $ref: "s.json" } }), deps);
    expect(calls.map((c) => [c.owner, c.repo, c.ref, c.path])).toEqual([
      ["o", "r", "main", "d/s.json"],
      ["o", "r", "dev", "d/s.json"],
    ]);
  });

  it("host allowlist is overridable; non-allowlisted hosts go through plain https", async () => {
    const { deps, calls } = gitDeps({ "d/s.json": '{"a":1}' });
    const r = await resolveJsonSchemaRefs(
      "https://ghe.test/o/r/blob/main/d/root.json",
      json({ a: { $ref: "s.json" } }),
      { ...deps, internalGitHosts: ["ghe.test"] },
    );
    expect(calls).toHaveLength(1);
    expect(r.resolved.size).toBe(2);
    const { deps: d2, calls: c2 } = gitDeps({});
    const r2 = await resolveJsonSchemaRefs("https://ghe.test/o/r/blob/main/d/root.json", json({ a: { $ref: "s.json" } }), d2);
    expect(c2).toHaveLength(0);
    expect(r2.unreachable.size).toBe(1);
  });

  it("does not use gh for a git-host ref reached over http:", async () => {
    const { deps, calls } = gitDeps({});
    const r = await resolveJsonSchemaRefs(PP_ROOT, json({ a: { $ref: "http://github.example.com/o/r/blob/m/a.json" } }), deps);
    expect(calls).toHaveLength(0);
    expect([...r.unreachable.values()][0]).toContain('"http"');
  });
});

describe("security 5: default https fetcher redirects", () => {
  const redirect = (loc: string) => new Response(null, { status: 302, headers: { location: loc } });

  it("refuses a redirect to a different host (never fetches it)", async () => {
    const { createDefaultFetchHttp } = await import("@/lib/importers/jsonschema-ref-resolver");
    const fetchMock = vi.fn(async () => redirect("https://169.254.169.254/latest/meta-data"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(createDefaultFetchHttp({}, PUBLIC)("https://example.com/a.json")).rejects.toThrow(/different host/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("follows a same-host redirect but not to http:", async () => {
    const { createDefaultFetchHttp } = await import("@/lib/importers/jsonschema-ref-resolver");
    const seq = [redirect("/b.json"), new Response('{"ok":1}', { status: 200 })];
    vi.stubGlobal("fetch", vi.fn(async () => seq.shift()!));
    try {
      await expect(createDefaultFetchHttp({}, PUBLIC)("https://example.com/a.json")).resolves.toBe('{"ok":1}');
      vi.stubGlobal("fetch", vi.fn(async () => redirect("http://example.com/c.json")));
      await expect(createDefaultFetchHttp({}, PUBLIC)("https://example.com/a.json")).rejects.toThrow(/https/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("enforces the per-file byte cap while streaming", async () => {
    const { createDefaultFetchHttp } = await import("@/lib/importers/jsonschema-ref-resolver");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(500), { status: 200 })));
    try {
      await expect(createDefaultFetchHttp({ maxFileBytes: 100 }, PUBLIC)("https://example.com/a.json")).rejects.toThrow(/size/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("security 4: gh is spawned with an argument array", () => {
  function fakeExec(stdout = '{"ok":true}') {
    const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
    const exec = vi.fn(async (file: string, args: string[], opts: unknown) => {
      calls.push({ file, args, opts });
      return { stdout };
    });
    return { exec, calls };
  }
  const limits = { maxFileBytes: 1024 };

  it("passes owner/repo/ref/path as discrete argv elements to the gh binary", async () => {
    const { exec, calls } = fakeExec();
    const f = createGhFetchGitFile(exec, limits);
    const out = await f("github.example.com", "o", "r", "master", "a/b c.json");
    expect(out).toBe('{"ok":true}');
    expect(calls[0]!.file).toBe("gh");
    expect(calls[0]!.args).toEqual([
      "api", "--hostname", "github.example.com", "-H", "Accept: application/vnd.github.raw", "--",
      "repos/o/r/contents/a/b%20c.json?ref=master",
    ]);
  });

  it.each([
    ["--hostname evil", "o", "r", "--hostname evil"],
    ["x; rm -rf /", "o", "r", "x; rm -rf /"],
    ["a/../../b", "o", "r", "a/../../b"],
    ["owner as option", "--hostname", "r", "a.json"],
    ["repo with slash", "o", "r/../x", "a.json"],
  ])("refuses %s without ever spawning", async (_n, owner, repo, path) => {
    const { exec } = fakeExec();
    const f = createGhFetchGitFile(exec, limits);
    await expect(f("github.example.com", owner, repo, "master", path)).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses a non-allowlisted host", async () => {
    const { exec } = fakeExec();
    await expect(createGhFetchGitFile(exec, limits)("evil.example", "o", "r", "m", "a.json")).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it("maps gh failures to safe reasons", async () => {
    const mk = (msg: string, code?: string | number) =>
      createGhFetchGitFile(async () => {
        throw Object.assign(new Error(msg), { code, stderr: msg });
      }, limits);
    await expect(mk("gh: Not Found (HTTP 404) /Users/bob/x")("github.example.com", "o", "r", "m", "a.json")).rejects.toThrow(/not found/i);
    await expect(mk("gh: To get started with GitHub CLI, please run: gh auth login")("github.example.com", "o", "r", "m", "a.json")).rejects.toThrow(/auth/i);
    await expect(mk("spawn gh ENOENT", "ENOENT")("github.example.com", "o", "r", "m", "a.json")).rejects.toThrow(/not available/i);
  });
});
