import { createSign } from "node:crypto";
import { safePath, validateFiles } from "./artifact";
import { DeliveryError, type ArtifactFile, type Credentials, type DeliveryReceipt } from "./contracts";
import { externalJson } from "./http";

export interface GitRepository { host: string; owner: string; repo: string; api: string; web: string; }
export function parseRepository(raw: string): GitRepository {
  const normalized = raw.startsWith("git@") ? raw.replace(/^git@([^:]+):/, "https://$1/") : raw;
  const u = new URL(normalized);
  const allowed = (process.env.DEPLOYMENT_GIT_HOSTS ?? "github.com").split(",").map((h) => h.trim().toLowerCase());
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash || !allowed.includes(u.hostname.toLowerCase())) throw new DeliveryError("Configure an allowed GitHub host in DEPLOYMENT_GIT_HOSTS and use an HTTPS repository URL");
  const parts = u.pathname.replace(/\.git\/?$/, "").replace(/^\/|\/$/g, "").split("/");
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p === "." || p === "..")) throw new DeliveryError("Use a GitHub repository URL with owner and repository");
  return { host: u.hostname, owner: parts[0], repo: parts[1], api: u.hostname === "github.com" ? "https://api.github.com" : `${u.origin}/api/v3`, web: `${u.origin}/${parts.join("/")}` };
}

export function appJwt(credentials: Credentials): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const token = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: credentials.appId })}`;
  try { return `${token}.${createSign("RSA-SHA256").update(token).sign(credentials.privateKey!, "base64url")}`; }
  catch { throw new DeliveryError("The GitHub App private key is invalid"); }
}

export class GitHubClient {
  readonly repository: GitRepository;
  private token: string | undefined;
  constructor(url: string, private readonly credentials: Credentials) { this.repository = parseRepository(url); }
  async request<T>(method: "GET" | "POST" | "PATCH", path: string, data?: unknown, allow404 = false): Promise<T | null> {
    if (!this.token) {
      if (this.credentials.authType === "github-app") {
        if (!/^\d+$/.test(this.credentials.installationId ?? "")) throw new DeliveryError("Invalid GitHub App installation ID");
        const result = await externalJson<{ token: string }>(`${this.repository.api}/app/installations/${this.credentials.installationId}/access_tokens`, "POST", { Authorization: `Bearer ${appJwt(this.credentials)}`, "User-Agent": "SuperSchema" }, {});
        if (!result?.token) throw new DeliveryError("GitHub did not return an installation token");
        this.token = result.token;
      } else if (this.credentials.authType === "bearer" && this.credentials.token) this.token = this.credentials.token;
      else throw new DeliveryError("Git PR delivery requires a token or GitHub App credentials");
    }
    return externalJson<T>(`${this.repository.api}/repos/${this.repository.owner}/${this.repository.repo}${path}`, method,
      { Authorization: `Bearer ${this.token}`, "User-Agent": "SuperSchema", "X-GitHub-Api-Version": "2022-11-28" }, data, allow404);
  }
  async verify(): Promise<{ repository: string; writable: boolean }> {
    const result = await this.request<{ permissions?: { push?: boolean }; html_url: string }>("GET", "");
    if (!result?.permissions?.push) throw new DeliveryError("The connection cannot create branches in this repository");
    return { repository: this.repository.web, writable: true };
  }
  async base(branch: string): Promise<string> {
    if (!branch || /[\x00-\x20~^:?*\[\\]/.test(branch) || branch.includes("..") || branch.startsWith("-") || branch.endsWith("/")) throw new DeliveryError("Invalid Git base branch");
    const result = await this.request<{ object: { sha: string } }>("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!result?.object?.sha) throw new DeliveryError("Base branch was not found");
    return result.object.sha;
  }
  async tree(commit: string): Promise<{ path: string; sha: string; type: string; mode: string }[]> {
    const result = await this.request<{ tree: { path: string; sha: string; type: string; mode: string }[]; truncated: boolean }>("GET", `/git/trees/${encodeURIComponent(commit)}?recursive=1`);
    if (!result || result.truncated) throw new DeliveryError("Repository tree is too large for a complete validated preview");
    return result.tree;
  }
  async blob(sha: string): Promise<string> {
    const result = await this.request<{ content: string; encoding: string; size: number }>("GET", `/git/blobs/${encodeURIComponent(sha)}`);
    if (!result || result.encoding !== "base64" || result.size > 5 * 1024 * 1024) throw new DeliveryError("Repository file cannot be read within the size limit");
    return Buffer.from(result.content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  async readFiles(commit: string, select: (path: string) => boolean): Promise<ArtifactFile[]> {
    const entries = (await this.tree(commit)).filter((e) => e.type === "blob" && select(e.path));
    if (entries.length > 3000) throw new DeliveryError("The selected repository content exceeds the preparation limit");
    const files: ArtifactFile[] = [];
    let totalBytes = 0;
    // Small bounded batches avoid provider rate bursts.
    for (let i = 0; i < entries.length; i += 8) {
      const batch = await Promise.all(entries.slice(i, i + 8).map(async (entry) => {
      if (entry.mode !== "100644" && entry.mode !== "100755") throw new DeliveryError("Repository preparation does not follow symlinks");
      return { path: safePath(entry.path), content: await this.blob(entry.sha) };
      }));
      totalBytes += batch.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0);
      if (totalBytes > 50 * 1024 * 1024) throw new DeliveryError("Repository preparation exceeds the total size limit");
      files.push(...batch);
    }
    return files;
  }
  async prStatus(number: number): Promise<{ state: string; url: string }> {
    const result = await this.request<{ state: string; merged_at: string | null; html_url: string }>("GET", `/pulls/${number}`);
    if (!result) throw new DeliveryError("Pull request not found");
    return { state: result.merged_at ? "merged" : result.state, url: result.html_url };
  }
  async deliver(input: { baseBranch: string; baseSha: string; branch: string; files: ArtifactFile[]; title: string; body: string; marker: string }): Promise<DeliveryReceipt> {
    validateFiles(input.files);
    const branchPath = `/git/ref/heads/${encodeURIComponent(input.branch)}`;
    const existing = await this.request<{ object: { sha: string } }>("GET", branchPath, undefined, true);
    let commitSha: string;
    if (existing) {
      const commit = await this.request<{ message: string; tree: { sha: string }; parents: { sha: string }[] }>("GET", `/git/commits/${existing.object.sha}`);
      if (!commit?.message.includes(input.marker)) throw new DeliveryError("The delivery branch already belongs to another change");
      if (commit.parents.length !== 1 || commit.parents[0].sha !== input.baseSha) throw new DeliveryError("The delivery branch changed; review a new preview");
      // A marker alone is insufficient after a user edits the branch. Verify every intended file.
      const tree = await this.tree(existing.object.sha);
      const baseTree = await this.tree(input.baseSha);
      const intended = new Set(input.files.map((f) => f.path));
      const originals = new Map(baseTree.filter((e) => e.type !== "tree").map((e) => [e.path, e]));
      const remaining = tree.filter((e) => e.type !== "tree" && !intended.has(e.path));
      if (remaining.length !== [...originals.keys()].filter((p) => !intended.has(p)).length || remaining.some((e) => {
        const original = originals.get(e.path);
        return !original || original.sha !== e.sha || original.mode !== e.mode || original.type !== e.type;
      })) throw new DeliveryError("The delivery branch contains unrelated changes; review a new preview");
      for (const file of input.files) {
        const entry = tree.find((e) => e.path === file.path && e.type === "blob" && e.mode === "100644");
        if (!entry || await this.blob(entry.sha) !== file.content) throw new DeliveryError("The delivery branch changed; review a new preview");
      }
      commitSha = existing.object.sha;
    } else {
      if (await this.base(input.baseBranch) !== input.baseSha) throw new DeliveryError("The base branch changed; create a new validated preview");
      const base = await this.request<{ tree: { sha: string } }>("GET", `/git/commits/${input.baseSha}`);
      if (!base) throw new DeliveryError("Base commit not found");
      const tree = await this.request<{ sha: string }>("POST", "/git/trees", { base_tree: base.tree.sha, tree: input.files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })) });
      const commit = await this.request<{ sha: string }>("POST", "/git/commits", { message: `${input.title}\n\n${input.marker}`, tree: tree?.sha, parents: [input.baseSha] });
      if (!commit?.sha) throw new DeliveryError("GitHub did not return a commit");
      commitSha = commit.sha;
      await this.request("POST", "/git/refs", { ref: `refs/heads/${input.branch}`, sha: commitSha });
    }
    const head = `${this.repository.owner}:${input.branch}`;
    const prs = await this.request<{ number: number; html_url: string; state: string }[]>("GET", `/pulls?state=all&head=${encodeURIComponent(head)}&base=${encodeURIComponent(input.baseBranch)}`);
    const existingPr = prs?.[0];
    const pr = existingPr ?? await this.request<{ number: number; html_url: string; state: string }>("POST", "/pulls", { title: input.title, body: input.body, head: input.branch, base: input.baseBranch });
    if (!pr?.number || !pr.html_url) throw new DeliveryError("GitHub did not return a pull request", false, true);
    return { outcome: "pr-opened", url: pr.html_url, prNumber: pr.number, branch: input.branch, commitSha, state: pr.state };
  }
}
