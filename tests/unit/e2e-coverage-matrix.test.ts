/**
 * docs/testing/e2e-coverage-matrix.md says what the browser suite covers, by area. It must not rot: every spec file is named in it, every page of the
 * route table is named in it, every known defect it cites exists, and its per-spec table is the output of `node scripts/e2e-counts.mjs --specs`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DASHBOARD_ROUTES } from "../e2e/fixtures/routes";
import { COUNTED_TIERS, blockOf, listTier, renderSpecTable, specTable } from "../../scripts/e2e-counts.mjs";

const REPO = path.resolve(__dirname, "../..");
const MATRIX = readFileSync(path.join(REPO, "docs", "testing", "e2e-coverage-matrix.md"), "utf8");
const KNOWN_DEFECTS = readFileSync(path.join(REPO, "docs", "testing", "known-defects.md"), "utf8");

/** The part of the matrix above the generated per-spec table: the hand-written rows. */
const BY_AREA = MATRIX.slice(0, MATRIX.indexOf("## Per-spec table"));

describe("the coverage matrix", () => {
  const specs = readdirSync(path.join(REPO, "tests", "e2e")).filter((name) => name.endsWith(".spec.ts"));

  it("names every spec file of tests/e2e in a row of the areas table (a new spec needs a row)", () => {
    expect(specs.length).toBeGreaterThan(20);
    const missing = specs.filter((spec) => !BY_AREA.includes(`\`${spec}\``));
    expect(missing, "add the spec to the row of the area it covers in docs/testing/e2e-coverage-matrix.md").toEqual([]);
  });

  it("names no spec file that does not exist", () => {
    const cited = [...BY_AREA.matchAll(/`([\w.-]+\.spec\.ts)`/g)].map((m) => m[1]);
    expect(cited.filter((name) => !specs.includes(name))).toEqual([]);
  });

  it("names every page of the route table (tests/e2e/fixtures/routes.ts)", () => {
    const missing = DASHBOARD_ROUTES.map((route) => route.path).filter((route) => !BY_AREA.includes(`\`${route}\``));
    expect(missing, "name the page in the 'Page sweep' row").toEqual([]);
  });

  it("cites only known defects that are entries of known-defects.md", () => {
    const entries = new Set([...KNOWN_DEFECTS.matchAll(/^## (KD-\d{3}):/gm)].map((m) => m[1]));
    const cited = [...new Set([...MATRIX.matchAll(/KD-\d{3}/g)].map((m) => m[0]))];
    expect(cited.length).toBeGreaterThan(10);
    expect(cited.filter((id) => !entries.has(id))).toEqual([]);
  });

  it("states each tier the way the docs do, and the tags", () => {
    for (const word of ["smoke", "regression", "nightly", "visual", "corpus", "@slow", "@external"]) expect(MATRIX).toContain(word);
  });

  it("has the per-spec table that `node scripts/e2e-counts.mjs --specs` prints now (regenerate it with --update-matrix after adding or removing a test)", () => {
    const tiers = Object.fromEntries(COUNTED_TIERS.map((tier) => [tier, listTier(tier)]));
    const expected = renderSpecTable(specTable(tiers), COUNTED_TIERS);
    const written = blockOf(MATRIX, "counts");
    expect(written, "the markers <!-- counts:begin --> / <!-- counts:end --> are missing").toBeDefined();
    expect(written, "run: node scripts/e2e-counts.mjs --specs --update-matrix").toBe(expected);
  }, 180_000);
});

describe("the release checklist of docs/testing/e2e.md", () => {
  const docs = readFileSync(path.join(REPO, "docs", "testing", "e2e.md"), "utf8");
  const checklist = docs.slice(docs.indexOf("## Release checklist"), docs.indexOf("## What you need"));
  const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };

  it("is the first section after the introduction, and has the five steps in order", () => {
    expect(docs.indexOf("## Release checklist")).toBeGreaterThan(0);
    expect(docs.indexOf("## Release checklist")).toBeLessThan(docs.indexOf("## What you need"));
    const commands = [...checklist.matchAll(/^\| (\d) \| `([^`]+)` \|/gm)].map((m) => [m[1], m[2]]);
    expect(commands).toEqual([
      ["1", "npm run test:e2e:release:smoke"],
      ["2", "npm run test:e2e:release"],
      ["3", "npm run test:e2e:visual"],
      ["4", "npm run test:corpus"],
      ["5", "npx vitest run tests/unit"],
    ]);
  });

  it("names only npm scripts that package.json has, and node scripts that exist", () => {
    for (const [, script] of checklist.matchAll(/npm run ([\w:-]+)/g)) expect(manifest.scripts, `npm run ${script}`).toHaveProperty(script);
    for (const [, file] of checklist.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)) expect(existsSync(path.join(REPO, file)), file).toBe(true);
  });

  it("says what `npm run test:e2e:release` is, so nobody takes it for everything: the nightly tier, no visual, no corpus", () => {
    expect(manifest.scripts["test:e2e:release"]).toBe("node scripts/e2e-release.mjs --tier nightly");
    expect(manifest.scripts["test:e2e:release:smoke"]).toBe("node scripts/e2e-release.mjs --tier smoke");
    expect(manifest.scripts["test:e2e:visual"]).toBe("node scripts/e2e-update-snapshots.mjs --check");
    expect(manifest.scripts["test:corpus"]).toBe("CORPUS=1 vitest run tests/integration/corpus");
    expect(checklist).toMatch(/EVERYTHING EXCEPT the visual tier and the corpus/);
    expect(checklist).toMatch(/`npx vitest run tests\/unit`.*\n/);
    expect(checklist).toMatch(/Not `npm test`: that is `vitest` in watch mode/);
  });

  it("gives the exit codes of the runner (0, 1, 2, 3, 124, 128+n), where reports and server.log live, and how to clean leftovers", () => {
    for (const piece of ["**0** passed", "**1** a test failed", "**2** a usage error", "**3** the environment", "**124**", "**128 + n**", "server.log", "docker ps -a --filter name=ss-e2e-"]) {
      expect(checklist, piece).toContain(piece);
    }
  });
});
