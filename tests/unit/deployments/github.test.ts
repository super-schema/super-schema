import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/deployments/http", () => ({ externalJson: h.call }));
import { appJwt, GitHubClient, parseRepository } from "@/lib/deployments/github";

beforeEach(() => { h.call.mockReset(); });
describe("real GitHub API protocol", () => {
  function remote() {
    let base = "base", branch: string | undefined, commitMessage = "", pr: { number: number; html_url: string; state: string } | undefined;
    let files = new Map<string, string>();
    const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
    h.call.mockImplementation(async (url: string, method: string, _headers: unknown, body?: Record<string, unknown>) => {
      const u = new URL(url), p = decodeURIComponent(u.pathname.replace("/repos/acme/contracts", ""));
      calls.push({ method, path: p + u.search, body });
      if (p === "" && method === "GET") return { permissions: { push: true } };
      if (p === "/git/ref/heads/main") return { object: { sha: base } };
      if (p.startsWith("/git/ref/heads/")) return branch ? { object: { sha: branch } } : null;
      if (p === "/git/commits/base") return { tree: { sha: "base-tree" } };
      if (p === "/git/trees" && method === "POST") { files = new Map((body!.tree as { path: string; content: string }[]).map((f) => [f.path, f.content])); return { sha: "new-tree" }; }
      if (p === "/git/commits" && method === "POST") { commitMessage = String(body!.message); return { sha: "new-commit" }; }
      if (p === "/git/refs" && method === "POST") { branch = String(body!.sha); return {}; }
      if (p === "/git/commits/new-commit") return { message: commitMessage, tree: { sha: "new-tree" }, parents: [{ sha: "base" }] };
      if (p === "/git/trees/base") return { tree: [], truncated: false };
      if (p === "/git/trees/new-commit") return { tree: [...files].map(([path]) => ({ path, sha: path, type: "blob", mode: "100644" })), truncated: false };
      if (p.startsWith("/git/blobs/")) return { content: Buffer.from(files.get(p.slice(11)) ?? "").toString("base64"), encoding: "base64", size: 1 };
      if (p === "/pulls" && method === "GET") return pr ? [pr] : [];
      if (p === "/pulls" && method === "POST") { pr = { number: 17, html_url: "https://github.com/acme/contracts/pull/17", state: "open" }; return pr; }
      throw new Error(`Unexpected API request ${method} ${p}`);
    });
    return { calls, moveBase: () => { base = "changed"; }, editBranch: () => { files.set("schemas/paypal/account.json", "someone else's changes"); }, addUnrelated: () => { files.set("unreviewed.txt", "extra"); } };
  }
  const input = () => ({ baseBranch: "main", baseSha: "base", branch: "superschema/account-123", files: [{ path: "schemas/paypal/account.json", content: '{"title":"Account"}' }], title: "Publish Account", body: "Validated files", marker: "SuperSchema-Delivery: run-1 hash" });
  it("writes a tree based on the pinned base, commits it, creates a feature branch, then opens a PR", async () => {
    const state = remote();
    const receipt = await new GitHubClient("https://github.com/acme/contracts", { authType: "bearer", token: "secret" }).deliver(input());
    expect(receipt).toMatchObject({ outcome: "pr-opened", commitSha: "new-commit", prNumber: 17 });
    const writes = state.calls.filter((c) => c.method === "POST");
    expect(writes.map((c) => c.path)).toEqual(["/git/trees", "/git/commits", "/git/refs", "/pulls"]);
    expect(writes[0].body).toMatchObject({ base_tree: "base-tree", tree: [{ path: "schemas/paypal/account.json", content: '{"title":"Account"}' }] });
    expect(writes[1].body?.parents).toEqual(["base"]);
    expect(writes[2].body?.ref).toBe("refs/heads/superschema/account-123");
  });
  it("reconciles a previously created branch and PR without another write", async () => {
    const state = remote(); const client = new GitHubClient("https://github.com/acme/contracts", { authType: "bearer", token: "secret" });
    const first = await client.deliver(input()); const writeCount = state.calls.filter((c) => c.method === "POST").length;
    state.moveBase(); // An existing verified receipt can be recovered even after main moves.
    expect(await client.deliver(input())).toEqual(first);
    expect(state.calls.filter((c) => c.method === "POST")).toHaveLength(writeCount);
  });
  it("does not overwrite an edited delivery branch or deliver against a different base", async () => {
    const state = remote(); const client = new GitHubClient("https://github.com/acme/contracts", { authType: "bearer", token: "secret" });
    await client.deliver(input()); state.editBranch();
    await expect(client.deliver(input())).rejects.toThrow(/branch changed/);
    const changed = remote(); changed.moveBase();
    await expect(client.deliver(input())).rejects.toThrow(/base branch changed/);
    expect(changed.calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("supports other repositories on the same host without hard-coded organization names", () => {
    expect(parseRepository("git@github.com:another-org/another-repo.git")).toMatchObject({ owner: "another-org", repo: "another-repo" });
    expect(() => parseRepository("https://token@github.com/acme/repo")).toThrow();
    expect(() => parseRepository("https://unknown.example/acme/repo")).toThrow(/allowed GitHub/);
  });
  it("refuses reconciliation when the branch contains unreviewed additions", async () => {
    const state = remote(); const client = new GitHubClient("https://github.com/acme/contracts", { authType: "bearer", token: "secret" });
    await client.deliver(input()); state.addUnrelated();
    await expect(client.deliver(input())).rejects.toThrow(/unrelated changes/);
  });
  it("signs short-lived GitHub App JWTs with the installation's RSA key", () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = appJwt({ authType: "github-app", appId: "123", installationId: "456", privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ iss: "123" });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});
