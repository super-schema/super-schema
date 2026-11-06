/**
 * scripts/import-git-cli.mjs: the pure parts of `npm run import:git` (argument parsing, the URL list file, the report summary).
 * The command itself (fetch + persist) is a thin shell over the app's importer and creation code.
 */
import { describe, expect, it } from "vitest";
import { parseImportArgs, parseUrlList, summarizeReport } from "../../../scripts/import-git-cli.mjs";

describe("parseImportArgs", () => {
  it("reads domain, product, urls and flags", () => {
    const parsed = parseImportArgs(["--domain", "identity", "--product", "Accounts", "--dry-run", "https://h/o/r/blob/m/a.json", "https://h/o/r/blob/m/b.json"]);
    expect(parsed).toEqual({
      ok: true,
      options: { domain: "identity", product: "Accounts", dryRun: true, urls: ["https://h/o/r/blob/m/a.json", "https://h/o/r/blob/m/b.json"], files: [], report: undefined, gitMode: undefined, user: undefined },
    });
  });

  it("accepts --key=value, repeated --file, --report, --git-mode and --user", () => {
    const parsed = parseImportArgs(["--domain=d", "--product=p", "--file=a.txt", "--file", "b.txt", "--report", "r.json", "--git-mode", "any", "--user", "a@b.c"]);
    expect(parsed.ok && parsed.options).toMatchObject({ domain: "d", product: "p", files: ["a.txt", "b.txt"], report: "r.json", gitMode: "any", user: "a@b.c", dryRun: false });
  });

  it("refuses a missing domain/product (unless --dry-run), no urls, an unknown flag and a bad --git-mode", () => {
    expect(parseImportArgs(["--product", "p", "https://x/y"])).toMatchObject({ ok: false, error: expect.stringContaining("--domain") });
    expect(parseImportArgs(["--domain", "d", "https://x/y"])).toMatchObject({ ok: false, error: expect.stringContaining("--product") });
    expect(parseImportArgs(["--domain", "d", "--product", "p"])).toMatchObject({ ok: false, error: expect.stringContaining("URL") });
    expect(parseImportArgs(["--dry-run", "https://x/y"]).ok).toBe(true);
    expect(parseImportArgs(["--bogus", "https://x/y"])).toMatchObject({ ok: false, error: expect.stringContaining("--bogus") });
    expect(parseImportArgs(["--dry-run", "--git-mode", "open", "https://x/y"])).toMatchObject({ ok: false, error: expect.stringContaining("--git-mode") });
    expect(parseImportArgs(["--domain"])).toMatchObject({ ok: false });
  });

  it("only https URLs count as urls", () => {
    expect(parseImportArgs(["--dry-run", "file:///etc/passwd"])).toMatchObject({ ok: false });
  });
});

describe("parseUrlList", () => {
  it("one URL per line, blank lines and # comments ignored, duplicates dropped, order kept", () => {
    const text = "# identity\nhttps://h/a.json\n\n  https://h/b.json  \nhttps://h/a.json\n# end\n";
    expect(parseUrlList(text)).toEqual(["https://h/a.json", "https://h/b.json"]);
  });
});

describe("summarizeReport", () => {
  it("counts per kind and lists what failed", () => {
    const summary = summarizeReport({
      imported: ["entity A", "entity B", "enum C", "scalar D"],
      skipped: ["x: already exists"],
      failed: ["u: boom"],
      unresolved: ["a", "a", "b"],
      notes: [],
    });
    expect(summary).toContain("2 entities, 1 enums, 1 scalars");
    expect(summary).toContain("1 skipped");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("2 distinct unresolved");
  });
});
