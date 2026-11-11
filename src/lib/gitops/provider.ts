import { createHmac, timingSafeEqual } from "node:crypto";
import {
  appJwt,
  parseRepository,
  type GitRepository,
} from "@/lib/deployments/github";
import { externalJson } from "@/lib/deployments/http";
import {
  branch as branchSchema,
  GitOpsError,
  type FileChange,
  type PrState,
} from "./contracts";

export interface GitProvider {
  readonly repository: GitRepository;
  base(branch: string): Promise<string>;
  tree(sha: string): Promise<TreeEntry[]>;
  readFiles(
    sha: string,
    select: (path: string) => boolean,
  ): Promise<{ path: string; content: string; sha: string }[]>;
  commit(
    input: CommitInput,
  ): Promise<{ sha: string; prNumber: number; prUrl: string }>;
  pullRequest(number: number): Promise<PrState>;
  close(number: number): Promise<void>;
}
export interface TreeEntry {
  path: string;
  sha: string;
  type: string;
  mode: string;
}
export interface CommitInput {
  baseBranch: string;
  baseSha: string;
  branch: string;
  root?: string;
  expectedHead?: string;
  files: FileChange[];
  title: string;
  body: string;
  marker: string;
}
export class GitHubProvider implements GitProvider {
  readonly repository: GitRepository;
  constructor(
    url: string,
    private readonly token: string,
  ) {
    this.repository = parseRepository(url);
  }
  static async installation(
    url: string,
    app: { appId: string; privateKey: string },
    installationId: string,
  ): Promise<GitHubProvider> {
    const repo = parseRepository(url);
    if (!/^\d+$/.test(installationId))
      throw new GitOpsError("Invalid installation id");
    const result = await externalJson<{ token: string }>(
      `${repo.api}/app/installations/${installationId}/access_tokens`,
      "POST",
      {
        Authorization: `Bearer ${appJwt({ authType: "github-app", ...app })}`,
        "User-Agent": "SuperSchema-GitOps",
      },
      {},
    );
    if (!result?.token)
      throw new GitOpsError("GitHub did not return an installation token");
    return new GitHubProvider(url, result.token);
  }
  async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    data?: unknown,
    missing = false,
  ): Promise<T | null> {
    return externalJson<T>(
      `${this.repository.api}/repos/${this.repository.owner}/${this.repository.repo}${path}`,
      method,
      {
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "SuperSchema-GitOps",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      data,
      missing,
    );
  }
  async actor(): Promise<{ id: number; login: string; type: string }> {
    const actor = await externalJson<{
      id: number;
      login: string;
      type: string;
    }>(`${this.repository.api}/user`, "GET", {
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "SuperSchema-GitOps",
    });
    if (!actor || actor.type !== "User")
      throw new GitOpsError(
        "Source pull requests require a linked human GitHub account",
      );
    return actor;
  }
  async verify(): Promise<{ writable: boolean; protected: boolean }> {
    const repo = await this.request<{ permissions?: { push?: boolean } }>(
      "GET",
      "",
    );
    if (!repo?.permissions?.push)
      throw new GitOpsError(
        "The GitHub identity cannot write to the selected repository",
      );
    return { writable: true, protected: false };
  }
  async base(branch: string): Promise<string> {
    branchSchema.parse(branch);
    const ref = await this.request<{ object: { sha: string } }>(
      "GET",
      `/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (!ref?.object.sha)
      throw new GitOpsError("The configured base branch does not exist");
    return ref.object.sha;
  }
  async tree(sha: string): Promise<TreeEntry[]> {
    const t = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(
      "GET",
      `/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    );
    if (!t || t.truncated || t.tree.length > 100000)
      throw new GitOpsError("Cannot index an incomplete repository tree");
    return t.tree;
  }
  async blob(sha: string): Promise<string> {
    const b = await this.request<{
      content: string;
      encoding: string;
      size: number;
    }>("GET", `/git/blobs/${encodeURIComponent(sha)}`);
    if (!b || b.encoding !== "base64" || b.size > 5 * 1024 * 1024)
      throw new GitOpsError("Canonical blob exceeds the read limit");
    return Buffer.from(b.content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  async readFiles(
    sha: string,
    select: (path: string) => boolean,
  ): Promise<{ path: string; content: string; sha: string }[]> {
    const entries = (await this.tree(sha)).filter(
      (e) => e.type !== "tree" && select(e.path),
    );
    if (entries.length > 10000)
      throw new GitOpsError("Canonical tree exceeds 10000 files");
    const files: { path: string; content: string; sha: string }[] = [];
    let bytes = 0;
    for (let i = 0; i < entries.length; i += 8) {
      const batch = await Promise.all(
        entries.slice(i, i + 8).map(async (e) => {
          if (e.type !== "blob" || e.mode !== "100644")
            throw new GitOpsError(
              "Canonical files must be regular non-executable files",
            );
          return { path: e.path, sha: e.sha, content: await this.blob(e.sha) };
        }),
      );
      bytes += batch.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
      if (bytes > 50 * 1024 * 1024)
        throw new GitOpsError("Canonical content exceeds 50 MiB");
      files.push(...batch);
    }
    return files;
  }
  async commit(
    input: CommitInput,
  ): Promise<{ sha: string; prNumber: number; prUrl: string }> {
    branchSchema.parse(input.baseBranch);
    branchSchema.parse(input.branch);
    if (
      input.branch === input.baseBranch ||
      !input.files.length ||
      input.files.length > 3000 ||
      new Set(input.files.map((f) => f.path)).size !== input.files.length
    )
      throw new GitOpsError("Invalid or empty atomic file change set");
    for (const f of input.files)
      if (
        (input.root && !f.path.startsWith(`${input.root}/`)) ||
        !f.path ||
        f.path.startsWith("/") ||
        f.path.includes("\\") ||
        /[\x00-\x1f]/.test(f.path) ||
        f.path.split("/").some((p) => !p || p === ".." || p === ".")
      )
        throw new GitOpsError("Unsafe Git file path");
    const refPath = `/git/ref/heads/${encodeURIComponent(input.branch)}`;
    const head = await this.request<{ object: { sha: string } }>(
      "GET",
      refPath,
      undefined,
      true,
    );
    let parent = input.expectedHead ?? input.baseSha;
    if (head && !input.expectedHead) {
      const commit = await this.request<{
        message: string;
        parents: { sha: string }[];
      }>("GET", `/git/commits/${head.object.sha}`);
      if (
        !commit?.message.includes(input.marker) ||
        commit.parents[0]?.sha !== input.baseSha
      )
        throw new GitOpsError(
          "The deterministic branch belongs to a different change",
        );
      const actual = new Map(
        (await this.tree(head.object.sha))
          .filter((e) => e.type !== "tree")
          .map((e) => [e.path, e]),
      );
      const base = new Map(
        (await this.tree(input.baseSha))
          .filter((e) => e.type !== "tree")
          .map((e) => [e.path, e]),
      );
      const paths = new Set(input.files.map((f) => f.path));
      for (const [path, e] of actual)
        if (!paths.has(path) && base.get(path)?.sha !== e.sha)
          throw new GitOpsError("The recovery branch has unrelated edits");
      for (const [path, e] of base)
        if (!paths.has(path) && actual.get(path)?.sha !== e.sha)
          throw new GitOpsError("The recovery branch removed unrelated files");
      for (const f of input.files) {
        const e = actual.get(f.path);
        if (
          f.content === null
            ? !!e
            : !e ||
              e.mode !== "100644" ||
              (await this.blob(e.sha)) !== f.content
        )
          throw new GitOpsError(
            "The recovery branch does not match the frozen change set",
          );
      }
      parent = head.object.sha;
    } else {
      if (
        (head && head.object.sha !== input.expectedHead) ||
        (!head && input.expectedHead)
      )
        throw new GitOpsError(
          "The PR branch changed; refresh before submitting",
          "OUT_OF_DATE",
        );
      if (!head && (await this.base(input.baseBranch)) !== input.baseSha)
        throw new GitOpsError(
          "The base branch changed; refresh before submitting",
          "OUT_OF_DATE",
        );
      const prior = await this.request<{ tree: { sha: string } }>(
        "GET",
        `/git/commits/${parent}`,
      );
      const tree = await this.request<{ sha: string }>("POST", "/git/trees", {
        base_tree: prior?.tree.sha,
        tree: input.files.map((f) => ({
          path: f.path,
          mode: "100644",
          type: "blob",
          ...(f.content === null ? { sha: null } : { content: f.content }),
        })),
      });
      const commit = await this.request<{ sha: string }>(
        "POST",
        "/git/commits",
        {
          message: `${input.title}\n\n${input.marker}`,
          tree: tree?.sha,
          parents: [parent],
        },
      );
      if (!commit?.sha)
        throw new GitOpsError("GitHub did not return an atomic commit");
      parent = commit.sha;
      if (head)
        await this.request(
          "PATCH",
          `/git/refs/heads/${encodeURIComponent(input.branch)}`,
          { sha: parent, force: false },
        );
      else
        await this.request("POST", "/git/refs", {
          ref: `refs/heads/${input.branch}`,
          sha: parent,
        });
    }
    const prs = await this.request<
      {
        number: number;
        html_url: string;
        state: string;
        merged_at: string | null;
      }[]
    >(
      "GET",
      `/pulls?state=all&head=${encodeURIComponent(`${this.repository.owner}:${input.branch}`)}&base=${encodeURIComponent(input.baseBranch)}&per_page=100`,
    );
    const existing = prs?.find((p) => p.state === "open");
    if (prs?.some((p) => p.merged_at) && !existing)
      throw new GitOpsError(
        "This change was already merged; synchronize before creating another PR",
      );
    const pr = existing
      ? await this.request<{ number: number; html_url: string }>(
          "PATCH",
          `/pulls/${existing.number}`,
          { title: input.title, body: input.body },
        )
      : await this.request<{ number: number; html_url: string }>(
          "POST",
          "/pulls",
          {
            head: input.branch,
            base: input.baseBranch,
            title: input.title,
            body: input.body,
          },
        );
    if (!pr?.number)
      throw new GitOpsError("GitHub did not return a pull request");
    return { sha: parent, prNumber: pr.number, prUrl: pr.html_url };
  }
  async pullRequest(number: number): Promise<PrState> {
    const p = await this.request<{
      number: number;
      html_url: string;
      head: { sha: string };
      base: { sha: string };
      merged: boolean;
      state: string;
      mergeable: boolean | null;
      user: { id: number };
    }>("GET", `/pulls/${number}`);
    if (!p) throw new GitOpsError("Pull request not found");
    const [reviews, checks, status] = await Promise.all([
      this.request<
        { id: number; user: { id: number }; state: string; commit_id: string }[]
      >("GET", `/pulls/${number}/reviews?per_page=100`),
      this.request<{
        total_count: number;
        check_runs: {
          name: string;
          status: string;
          conclusion: string | null;
        }[];
      }>("GET", `/commits/${p.head.sha}/check-runs?per_page=100`),
      this.request<{ state: string }>("GET", `/commits/${p.head.sha}/status`),
    ]);
    const latest = new Map<
      number,
      { id: number; state: string; commit_id: string }
    >();
    for (const r of reviews ?? [])
      if (r.user.id !== p.user.id && r.state !== "COMMENTED")
        latest.set(r.user.id, r);
    const requested = [...latest.values()].some(
      (r) => r.state === "CHANGES_REQUESTED",
    );
    const approved = [...latest.values()].some(
      (r) => r.state === "APPROVED" && r.commit_id === p.head.sha,
    );
    const failed =
      status?.state === "failure" ||
      status?.state === "error" ||
      (checks?.total_count ?? 0) > 100 ||
      checks?.check_runs.some((r) =>
        [
          "failure",
          "cancelled",
          "timed_out",
          "action_required",
          "startup_failure",
        ].includes(r.conclusion ?? ""),
      );
    const state = p.merged
      ? "MERGED"
      : p.state === "closed"
        ? "CLOSED"
        : p.mergeable === false
          ? "CONFLICT"
          : failed
            ? "CHECKS_FAILING"
            : requested
              ? "CHANGES_REQUESTED"
              : approved
                ? "APPROVED"
                : "IN_REVIEW";
    return {
      number: p.number,
      url: p.html_url,
      headSha: p.head.sha,
      baseSha: p.base.sha,
      merged: p.merged,
      closed: p.state === "closed",
      mergeable: p.mergeable,
      state,
      review: [...latest.values()],
      checks: {
        runs: checks?.check_runs ?? [],
        status: status?.state ?? "pending",
      },
    };
  }
  async close(number: number): Promise<void> {
    await this.request("PATCH", `/pulls/${number}`, { state: "closed" });
  }
  async protection(branch: string): Promise<boolean> {
    const p = await this.request<{
      required_pull_request_reviews?: { require_code_owner_reviews?: boolean };
    }>(
      "GET",
      `/branches/${encodeURIComponent(branch)}/protection`,
      undefined,
      true,
    );
    return (
      p?.required_pull_request_reviews?.require_code_owner_reviews === true
    );
  }
}
export function verifyWebhook(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
