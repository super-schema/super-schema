import { describe, expect, it, vi } from "vitest";
import { resolveJsonSchemaRefs, type ResolverDeps } from "@/lib/importers/jsonschema-ref-resolver";
import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";
import type { GitImportConfig } from "@/lib/importers/git-import-config";

/**
 * SCHEMA_IMPORT_GIT_SCOPES (owner / owner/repo) decides which repositories the server may read through its own `gh` credentials. It used to
 * be checked for the ROOT url only: a root document of an allowed repository could name `$ref`s into any other repository of its owner, and
 * the server fetched them. Every git fetch (root and refs) now passes the same check, before any `gh` call.
 */
const HOST = "https://github.paypal.com";
const ROOT_URL = `${HOST}/acme/schemas/blob/main/root.json`;
const SECRET = `${HOST}/acme/secret-repo/blob/main/s.json`;
const OTHER_ORG = `${HOST}/other-org/x/blob/main/s.json`;
const SIBLING = `${HOST}/acme/schemas/blob/main/sibling.json`;

const FILES: Record<string, string> = {
  "acme/schemas/main/sibling.json": JSON.stringify({ title: "Sibling", type: "object", properties: { a: { type: "string" } } }),
  "acme/secret-repo/main/s.json": JSON.stringify({ title: "SecretThing", type: "object", properties: { token: { type: "string", description: "PRIVATE CONTENT" } } }),
  "other-org/x/main/s.json": JSON.stringify({ title: "OtherThing", type: "object", properties: { b: { type: "string" } } }),
};
const rootDoc = JSON.stringify({
  title: "Root",
  type: "object",
  required: ["s"],
  properties: { s: { $ref: SECRET }, t: { $ref: OTHER_ORG }, u: { $ref: SIBLING } },
});

function harness(config: GitImportConfig, extra: Partial<ResolverDeps> = {}) {
  const calls: string[] = [];
  const fetchGitFile = vi.fn(async (_host: string, owner: string, repo: string, ref: string, path: string) => {
    calls.push(`${owner}/${repo}@${ref}:${path}`);
    const content = FILES[`${owner}/${repo}/${ref}/${path}`];
    if (!content) throw new Error("404");
    return content;
  });
  const deps: ResolverDeps = { gitImportConfig: config, fetchGitFile, lookup: async () => ["93.184.216.34"], ...extra };
  return { deps, calls, fetchGitFile };
}

describe("git scope applies to every ref, not only the root", () => {
  it("restricted to acme/schemas: a sibling file is fetched; another repo of the same owner and another owner are refused before any gh call", async () => {
    const { deps, calls } = harness({ mode: "restricted", scopes: ["acme/schemas"] });
    const refs = await resolveJsonSchemaRefs(ROOT_URL, rootDoc, deps);
    expect(calls).toEqual(["acme/schemas@main:sibling.json"]);
    expect(refs.resolved.has(SECRET)).toBe(false);
    expect(refs.resolved.has(OTHER_ORG)).toBe(false);
    expect(refs.unreachable.get(SECRET)).toMatch(/acme\/secret-repo is not enabled on this server/);
    expect(refs.unreachable.get(SECRET)).toContain("SCHEMA_IMPORT_GIT_SCOPES");
    expect(refs.unreachable.get(OTHER_ORG)).toMatch(/other-org\/x is not enabled on this server/);
  });

  it("the real gh runner is never spawned for the refused refs", async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const path = args.join(" ");
      if (path.includes("sibling.json")) return { stdout: FILES["acme/schemas/main/sibling.json"]! };
      throw new Error("unexpected gh call");
    });
    const refs = await resolveJsonSchemaRefs(ROOT_URL, rootDoc, {
      gitImportConfig: { mode: "restricted", scopes: ["acme/schemas"] },
      execFile,
      lookup: async () => ["93.184.216.34"],
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls.flat().join(" ")).not.toContain("secret-repo");
    expect(refs.resolved.size).toBe(2); // root + sibling
  });

  it("an `owner` entry covers every repository of that owner; an `owner/repo` entry only that repository", async () => {
    const owner = harness({ mode: "restricted", scopes: ["acme"] });
    await resolveJsonSchemaRefs(ROOT_URL, rootDoc, owner.deps);
    expect(owner.calls.sort()).toEqual(["acme/schemas@main:sibling.json", "acme/secret-repo@main:s.json"]);

    const repo = harness({ mode: "restricted", scopes: ["acme/secret-repo", "acme/schemas"] });
    await resolveJsonSchemaRefs(ROOT_URL, rootDoc, repo.deps);
    expect(repo.calls.sort()).toEqual(["acme/schemas@main:sibling.json", "acme/secret-repo@main:s.json"]);

    const only = harness({ mode: "restricted", scopes: ["acme/secret-repo"] });
    await resolveJsonSchemaRefs(ROOT_URL, rootDoc, only.deps);
    // the root repository itself is not in this list, so even its sibling is refused
    expect(only.calls).toEqual(["acme/secret-repo@main:s.json"]);
  });

  it("case-insensitive, like the root check", async () => {
    const { deps, calls } = harness({ mode: "restricted", scopes: ["ACME/Schemas"] });
    await resolveJsonSchemaRefs(ROOT_URL, rootDoc, deps);
    expect(calls).toEqual(["acme/schemas@main:sibling.json"]);
  });

  it("restricted with no scopes refuses every git ref", async () => {
    const { deps, calls, fetchGitFile } = harness({ mode: "restricted", scopes: [] });
    const refs = await resolveJsonSchemaRefs(ROOT_URL, rootDoc, deps);
    expect(fetchGitFile).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(refs.unreachable.size).toBe(3);
  });

  it("any mode keeps the organization rule: another owner is refused unless extraGitScopes opts it in", async () => {
    const plain = harness({ mode: "any" });
    await resolveJsonSchemaRefs(ROOT_URL, rootDoc, plain.deps);
    expect(plain.calls.sort()).toEqual(["acme/schemas@main:sibling.json", "acme/secret-repo@main:s.json"]);

    const opted = harness({ mode: "any" }, { extraGitScopes: ["github.paypal.com/other-org"] });
    await resolveJsonSchemaRefs(ROOT_URL, rootDoc, opted.deps);
    expect(opted.calls).toContain("other-org/x@main:s.json");
  });

  it("extraGitScopes cannot widen what the server configuration does not allow", async () => {
    const { deps, calls } = harness({ mode: "restricted", scopes: ["acme"] }, { extraGitScopes: ["github.paypal.com/other-org"] });
    const refs = await resolveJsonSchemaRefs(ROOT_URL, rootDoc, deps);
    expect(calls).not.toContain("other-org/x@main:s.json");
    expect(refs.unreachable.get(OTHER_ORG)).toMatch(/not enabled on this server/);
    // and with both the configuration and the extra scope, it is fetched
    const both = harness({ mode: "restricted", scopes: ["acme", "other-org"] }, { extraGitScopes: ["github.paypal.com/other-org"] });
    await resolveJsonSchemaRefs(ROOT_URL, rootDoc, both.deps);
    expect(both.calls).toContain("other-org/x@main:s.json");
  });

  it("through the URL import: the secret repository's entity is not in the result and the refusal is a warning", async () => {
    const files: Record<string, string> = { ...FILES, "acme/schemas/main/root.json": rootDoc };
    const calls: string[] = [];
    const r = await importJsonSchemaFromUrl(ROOT_URL, {
      gitImportConfig: { mode: "restricted", scopes: ["acme/schemas"] },
      fetchGitFile: async (_h, owner, repo, ref, path) => {
        calls.push(`${owner}/${repo}@${ref}:${path}`);
        const c = files[`${owner}/${repo}/${ref}/${path}`];
        if (!c) throw new Error("404");
        return c;
      },
      lookup: async () => ["93.184.216.34"],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(calls.sort()).toEqual(["acme/schemas@main:root.json", "acme/schemas@main:sibling.json"]);
    const names = r.data.entities.map((e) => e.name);
    expect(names).not.toContain("SecretThing");
    expect(names).not.toContain("OtherThing");
    expect(JSON.stringify(r.data)).not.toContain("PRIVATE CONTENT");
    expect(r.data.warnings.join("\n")).toMatch(/acme\/secret-repo is not enabled on this server/);
  });
});
