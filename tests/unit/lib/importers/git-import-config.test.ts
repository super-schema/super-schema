import { describe, expect, it, vi } from "vitest";
import { gitRootRefusal, parseGitScopes, readGitImportConfig } from "@/lib/importers/git-import-config";
import { fetchRootDocument } from "@/lib/importers/jsonschema-ref-resolver";
import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";

const GIT_URL = "https://github.paypal.com/Acme/Repo/blob/main/s/a.json";
const DOC = JSON.stringify({ type: "object", properties: { a: { type: "string" } } });

describe("readGitImportConfig", () => {
  it("defaults to restricted with no scopes", () => {
    expect(readGitImportConfig({})).toEqual({ mode: "restricted", scopes: [] });
  });
  it("unknown mode fails closed", () => {
    expect(readGitImportConfig({ SCHEMA_IMPORT_GIT_MODE: "yolo", SCHEMA_IMPORT_GIT_SCOPES: "a" })).toEqual({
      mode: "restricted",
      scopes: ["a"],
    });
  });
  it("any mode (case/whitespace tolerant) ignores scopes", () => {
    expect(readGitImportConfig({ SCHEMA_IMPORT_GIT_MODE: " ANY ", SCHEMA_IMPORT_GIT_SCOPES: "a" })).toEqual({ mode: "any" });
  });
  it("parses scopes: trim, lowercase, drop empties", () => {
    expect(parseGitScopes(" Acme , acme/Repo,, ,")).toEqual(["acme", "acme/repo"]);
    expect(parseGitScopes(undefined)).toEqual([]);
  });
});

describe("gitRootRefusal", () => {
  const cfg = readGitImportConfig({ SCHEMA_IMPORT_GIT_SCOPES: "Acme, other/Only" });
  it("allows owner and owner/repo case-insensitively", () => {
    expect(gitRootRefusal(cfg, "ACME", "anything")).toBeNull();
    expect(gitRootRefusal(cfg, "Other", "only")).toBeNull();
  });
  it("refuses others, naming owner/repo and env vars", () => {
    const m = gitRootRefusal(cfg, "Other", "else")!;
    expect(m).toContain("Other/else");
    expect(m).toContain("SCHEMA_IMPORT_GIT_SCOPES");
    expect(m).toContain("SCHEMA_IMPORT_GIT_MODE");
  });
  it("empty restricted refuses everything; any allows", () => {
    expect(gitRootRefusal({ mode: "restricted", scopes: [] }, "a", "b")).not.toBeNull();
    expect(gitRootRefusal({ mode: "any" }, "a", "b")).toBeNull();
  });
});

describe("fetchRootDocument git scope enforcement", () => {
  it("refuses before any gh call", async () => {
    const fetchGitFile = vi.fn(async () => DOC);
    const execFile = vi.fn();
    const r = await fetchRootDocument(GIT_URL, { fetchGitFile, execFile, gitImportConfig: { mode: "restricted", scopes: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Acme/Repo");
    expect(fetchGitFile).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
  it("allows a scoped owner and any mode", async () => {
    const fetchGitFile = vi.fn(async () => DOC);
    for (const gitImportConfig of [{ mode: "restricted", scopes: ["acme"] }, { mode: "any" }] as const) {
      const r = await fetchRootDocument(GIT_URL, { fetchGitFile, gitImportConfig });
      expect(r.ok).toBe(true);
    }
    expect(fetchGitFile).toHaveBeenCalledTimes(2);
  });
  it("does not affect plain https URLs", async () => {
    const fetchHttp = vi.fn(async () => DOC);
    const r = await fetchRootDocument("https://example.com/s.json", {
      fetchHttp,
      lookup: async () => ["93.184.216.34"],
      gitImportConfig: { mode: "restricted", scopes: [] },
    });
    expect(r.ok).toBe(true);
  });
  it("surfaces the refusal through importJsonSchemaFromUrl as an error Result", async () => {
    const fetchGitFile = vi.fn(async () => DOC);
    const r = await importJsonSchemaFromUrl(GIT_URL, { fetchGitFile, gitImportConfig: { mode: "restricted", scopes: [] } });
    expect(JSON.stringify(r)).toContain("SCHEMA_IMPORT_GIT_SCOPES");
    expect(fetchGitFile).not.toHaveBeenCalled();
  });
});
