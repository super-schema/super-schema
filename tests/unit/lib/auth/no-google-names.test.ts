/**
 * Google sign-in is out of scope (owner, 2026-10-25): logins are admin-controlled, and an administrator can add identity providers through the ONE registry
 * (src/lib/auth/providers.ts), where `google` is a row of the table like the others. So the old Google-only settings must not come back:
 * no `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS`, nor any other bare `GOOGLE_*` name, in the source, the scripts, the tests, the
 * environment example, the compose file or the operator docs. The generic names `AUTH_PROVIDER_GOOGLE_*` (in the docs' worked example, as written
 * out) are the one place the word appears, and they are not matched: only a `GOOGLE_` that does not follow another name part is.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../../../..");
const THIS_FILE = path.join("tests", "unit", "lib", "auth", "no-google-names.test.ts");

/** A `GOOGLE_` that starts a name: not preceded by a letter, a digit or an underscore (so `AUTH_PROVIDER_GOOGLE_CLIENT_ID` is not one). */
const BARE_GOOGLE_NAME = /(?<![A-Za-z0-9_])GOOGLE_[A-Z]/;

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", "generated", ".git", "test-results", "worker-dist"]);

function filesUnder(dir: string, extensions: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIPPED_DIRECTORIES.has(name)) return [];
    const file = path.join(dir, name);
    const info = statSync(file);
    if (info.isDirectory()) return filesUnder(file, extensions);
    return extensions.test(name) ? [file] : [];
  });
}

describe("no Google-specific setting is left", () => {
  const code = /\.(ts|tsx|mjs|cjs|js|json|yml|yaml|md|sql|prisma|example)$/;
  const files = [
    ...["src", "scripts", "prisma", "tests", ".docker", ".github"].flatMap((dir) => {
      try {
        return filesUnder(path.join(REPO, dir), code);
      } catch {
        return []; // a directory this checkout does not have
      }
    }),
    path.join(REPO, ".env.example"),
    ...filesUnder(path.join(REPO, "docs"), /\.md$/).filter((file) => !file.includes(`${path.sep}docs${path.sep}superpowers${path.sep}`)),
    ...readdirSync(REPO).filter((name) => /^(package\.json|playwright\.config\.ts|next\.config\.ts|docker-compose.*\.ya?ml|Dockerfile.*|AGENTS\.md|README\.md)$/.test(name)).map((name) => path.join(REPO, name)),
  ].filter((file) => path.relative(REPO, file) !== THIS_FILE);

  it("scans the places that matter (the scan itself is not empty)", () => {
    expect(files.length).toBeGreaterThan(500);
    const relative = files.map((file) => path.relative(REPO, file));
    for (const expected of [".env.example", "src/lib/auth/providers.ts", "scripts/e2e-env.mjs", "docs/auth.md", "docs/auth-ops.md", path.join("tests", "unit", "lib", "auth", "providers.test.ts")]) {
      expect(relative, expected).toContain(expected);
    }
  });

  it("the pattern means what it says", () => {
    for (const bare of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ALLOWED_DOMAINS", " GOOGLE_X", "=GOOGLE_ID", "(GOOGLE_SECRET)"]) expect(BARE_GOOGLE_NAME.test(bare), bare).toBe(true);
    for (const generic of ["AUTH_PROVIDER_GOOGLE_CLIENT_ID", "AUTH_PROVIDER_GOOGLE_ALLOWED_DOMAINS", "providerEnvName", "Google", "google", "GOOGLE"]) expect(BARE_GOOGLE_NAME.test(generic), generic).toBe(false);
  });

  it("has no GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ALLOWED_DOMAINS or any other bare GOOGLE_ name", () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("GOOGLE_")) continue; // the cheap test first: most files never say it
      text.split("\n").forEach((line, index) => {
        if (BARE_GOOGLE_NAME.test(line)) hits.push(`${path.relative(REPO, file)}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits, "the settings of a provider are AUTH_PROVIDER_<KEY>_* (docs/auth.md); the Google-only names are gone").toEqual([]);
    // (a whole-repository scan: 5 s under the load of the whole suite, so a 60 s limit instead of the default 5 s)
  }, 60_000);

  it("the settings docs show Google through the generic names only", () => {
    const docs = readFileSync(path.join(REPO, "docs", "auth.md"), "utf8");
    expect(docs).toContain("AUTH_PROVIDER_GOOGLE_CLIENT_ID");
    expect(docs).toContain("AUTH_PROVIDERS=google");
    expect(docs).not.toMatch(BARE_GOOGLE_NAME);
  });
});
