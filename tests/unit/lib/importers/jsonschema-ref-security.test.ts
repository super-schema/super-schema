import { describe, expect, it } from "vitest";
import {
  assertPublicHost,
  buildGhArgs,
  checkHttpsUrl,
  isBlockedIp,
  parseGitFileUrl,
  sanitizeReason,
  validateGitCoords,
  type GitCoords,
} from "@/lib/importers/jsonschema-ref-security";

const coords = (over: Partial<GitCoords> = {}): GitCoords => ({
  host: "github.paypal.com",
  owner: "Org",
  repo: "repo.name",
  ref: "master",
  path: "a/b.json",
  ...over,
});

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "0.0.0.0",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:10.1.2.3", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => expect(isBlockedIp(ip)).toBe(false),
  );
});

describe("checkHttpsUrl", () => {
  it("accepts a public https URL", () => {
    expect(checkHttpsUrl("https://example.com/a.json").ok).toBe(true);
  });
  it.each(["http://example.com/a", "file:///etc/passwd", "ftp://x/a", "data:text/plain,hi", "javascript:alert(1)", "gopher://x/1"])(
    "refuses scheme in %s and names it",
    (u) => {
      const r = checkHttpsUrl(u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(`"${u.split(":")[0]}"`);
    },
  );
  it.each([
    "https://localhost/a", "https://foo.localhost/a", "https://localhost./a", "https://127.0.0.1/a",
    "https://[::1]/a", "https://10.0.0.5/a", "https://169.254.169.254/latest/meta-data",
    "https://[::ffff:127.0.0.1]/a", "https://0.0.0.0/a", "https://2130706433/a", "https://0x7f.1/a",
    "https://100.64.1.1/a", "https://[fd00::1]/a", "https://[fe80::1]/a", "https://192.168.0.1/a", "https://172.16.5.5/a",
  ])("blocks %s", (u) => {
    expect(checkHttpsUrl(u).ok).toBe(false);
  });
  it.each(["https://example.com:8443/a", "https://example.com:22/a", "https://example.com:80/a"])("refuses a non-443 port in %s", (u) => {
    expect(checkHttpsUrl(u).ok).toBe(false);
  });
  it("accepts the default port, written or not", () => {
    expect(checkHttpsUrl("https://example.com:443/a").ok).toBe(true);
  });
  it("blocks a Teredo address", () => {
    expect(isBlockedIp("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(true);
    // 2001:db8::/32 is the documentation range: blocked too (jsonschema-ref-security-ranges.test.ts); another 2001: address is public
    expect(isBlockedIp("2001:db8::1")).toBe(true);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
  });
  it("refuses embedded credentials", () => {
    expect(checkHttpsUrl("https://user:pass@example.com/a").ok).toBe(false);
  });
});

describe("assertPublicHost", () => {
  it("rejects a name resolving to a private address", async () => {
    await expect(assertPublicHost(new URL("https://evil.example/a"), async () => ["10.0.0.1"])).rejects.toThrow(/blocked/);
  });
  it("rejects when any answer is private", async () => {
    await expect(assertPublicHost(new URL("https://evil.example/a"), async () => ["8.8.8.8", "127.0.0.1"])).rejects.toThrow();
  });
  it("fails closed when lookup fails", async () => {
    await expect(
      assertPublicHost(new URL("https://nx.example/a"), async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/resolved/);
  });
  it("accepts public answers", async () => {
    await expect(assertPublicHost(new URL("https://ok.example/a"), async () => ["93.184.216.34"])).resolves.toBeUndefined();
  });
});

describe("parseGitFileUrl", () => {
  const base = "https://github.paypal.com/ApiSpecifications-R/identity.CommonComponentsSpecification";
  it("parses blob URLs", () => {
    const r = parseGitFileUrl(`${base}/blob/master/v1/schema/a.json`);
    expect(r).toEqual({
      ok: true,
      coords: { host: "github.paypal.com", owner: "ApiSpecifications-R", repo: "identity.CommonComponentsSpecification", ref: "master", path: "v1/schema/a.json" },
    });
  });
  it("parses raw URLs", () => {
    const r = parseGitFileUrl(`${base}/raw/main/x/y.yaml`);
    expect(r.ok && r.coords.ref).toBe("main");
  });
  it("parses API contents URLs", () => {
    const r = parseGitFileUrl("https://github.paypal.com/api/v3/repos/o/r/contents/p/q.json?ref=dev");
    expect(r).toMatchObject({ ok: true, coords: { owner: "o", repo: "r", ref: "dev", path: "p/q.json" } });
  });
  it("refuses unknown hosts, http, credentials, ports", () => {
    expect(parseGitFileUrl("https://github.com/o/r/blob/m/a.json").ok).toBe(false);
    expect(parseGitFileUrl("http://github.paypal.com/o/r/blob/m/a.json").ok).toBe(false);
    expect(parseGitFileUrl("https://u:p@github.paypal.com/o/r/blob/m/a.json").ok).toBe(false);
    expect(parseGitFileUrl("https://github.paypal.com:8443/o/r/blob/m/a.json").ok).toBe(false);
  });
  it("honours an overridden host list", () => {
    expect(parseGitFileUrl("https://ghe.test/o/r/blob/m/a.json", ["ghe.test"]).ok).toBe(true);
  });
  it("refuses paths that escaped the blob prefix or traverse", () => {
    expect(parseGitFileUrl("https://github.paypal.com/o/x.json").ok).toBe(false);
    expect(parseGitFileUrl("https://github.paypal.com/o/r/blob/m/%2e%2e/b.json").ok).toBe(false);
    expect(parseGitFileUrl("https://github.paypal.com/o/r/blob/m/a%3Bb.json").ok).toBe(false);
  });
});

describe("validateGitCoords / buildGhArgs", () => {
  it("builds an argv with the endpoint last, after --", () => {
    expect(buildGhArgs(coords())).toEqual([
      "api", "--hostname", "github.paypal.com", "-H", "Accept: application/vnd.github.raw", "--",
      "repos/Org/repo.name/contents/a/b.json?ref=master",
    ]);
  });
  it.each([
    ["owner option", { owner: "--hostname" }],
    ["owner spaces", { owner: "evil host" }],
    ["repo semicolon", { repo: "x;rm" }],
    ["ref leading dash", { ref: "-x" }],
    ["ref dotdot", { ref: "a..b" }],
    ["path option", { path: "--hostname evil" }],
    ["path leading dash seg", { path: "a/--hostname" }],
    ["path shell", { path: "x; rm -rf /" }],
    ["path traversal", { path: "a/../../b" }],
    ["path dot", { path: "a/./b" }],
    ["path control", { path: "a/b\u0000c" }],
    ["path newline", { path: "a\nb" }],
    ["path empty seg", { path: "a//b" }],
    ["path backtick", { path: "`id`" }],
    ["path dollar", { path: "$(id)" }],
  ] as const)("refuses %s", (_n, over) => {
    expect(validateGitCoords(coords(over))).not.toBeNull();
    expect(() => buildGhArgs(coords(over))).toThrow();
  });
  it("refuses a host outside the allowlist", () => {
    expect(() => buildGhArgs(coords({ host: "evil.example" }))).toThrow(/unknown git host/);
    expect(() => buildGhArgs(coords({ host: "--hostname" }))).toThrow();
  });
});

describe("sanitizeReason", () => {
  it("strips paths, tokens and stack lines", () => {
    const out = sanitizeReason(new Error("ENOENT /Users/bob/secret/file.json ghp_abcdefghijklmnopqrstuv\n    at foo (/x/y.js:1:1)"));
    expect(out).not.toContain("/Users");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("at foo");
  });
  it("strips windows paths and bearer tokens", () => {
    const out = sanitizeReason("failed C:\\Users\\bob\\x.json with Bearer abcdefghijklmnop");
    expect(out).not.toContain("C:\\");
    expect(out).not.toContain("abcdefghijklmnop");
  });
});
