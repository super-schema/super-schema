/**
 * Which git-host (fetched through the server's own `gh` credentials) ROOT URLs the JSON Schema "From URL" import may
 * fetch. Without a restriction the server would act as a confused deputy for any caller-supplied repository.
 *
 *   SCHEMA_IMPORT_GIT_MODE    "any" | "restricted"            (default "restricted"; an unknown value is restricted)
 *   SCHEMA_IMPORT_GIT_SCOPES  comma-separated "owner" or "owner/repo" entries (read only in restricted mode;
 *                             empty + restricted = git-host import disabled)
 */
export type GitImportConfig = { mode: "any" } | { mode: "restricted"; scopes: string[] };

export const GIT_MODE_ENV = "SCHEMA_IMPORT_GIT_MODE";
export const GIT_SCOPES_ENV = "SCHEMA_IMPORT_GIT_SCOPES";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function parseGitScopes(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function readGitImportConfig(env: Env = process.env): GitImportConfig {
  const rawMode = env[GIT_MODE_ENV];
  const mode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : "";
  if (mode === "any") return { mode: "any" };
  return { mode: "restricted", scopes: parseGitScopes(env[GIT_SCOPES_ENV]) };
}

/** Null when allowed, else the refusal message. */
export function gitRootRefusal(config: GitImportConfig, owner: string, repo: string): string | null {
  if (config.mode === "any") return null;
  const o = owner.toLowerCase();
  const r = repo.toLowerCase();
  const scopes = config.scopes.map((s) => s.trim().toLowerCase());
  if (scopes.some((s) => s === o || s === `${o}/${r}`)) return null;
  return (
    `importing from the git repository ${owner}/${repo} is not enabled on this server. ` +
    `An administrator can allow it by adding "${owner}" or "${owner}/${repo}" to ${GIT_SCOPES_ENV} ` +
    `(or by setting ${GIT_MODE_ENV}=any)`
  );
}
