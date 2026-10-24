/**
 * Guard for the browser suite (tests/e2e): the rules of docs/superpowers/plans/2026-10-23-release-ui-suite.md that a reviewer would
 * otherwise have to check by eye on every new spec. It reads the specs as TypeScript syntax (not as text), so a comment or a string
 * that merely mentions `waitForTimeout(` is not an offence and a call spelled over several lines is not missed.
 *
 *   a. every `test(...)` call carries a tier tag in its details: `test(name, { tag: ["@regression"] }, fn)`;
 *   b. no `waitForTimeout(` sleep and no `networkidle` wait anywhere in tests/e2e, helpers included (a guess about time or about the
 *      network, not a state of the page);
 *   c. no `test.fixme` / `test.skip` that hides a test without a reason: a declarative one needs a bracketed reason in its title
 *      (`test.fixme("title [TRACKED: why]", fn)`), a conditional one (`test.skip(cond, "why")`) needs the reason string;
 *   d. no `test.use({ navigationTimeout | actionTimeout | screenshot | trace | video })`: playwright.config.ts owns them;
 *   e. no local `createDomain` / `createProduct` (helpers/lifecycle.ts) and no local copy of the other shared helpers
 *      (`createEventFromMenu`, `RAW_DB_TEXT`: helpers/event-builder.ts) outside `helpers/`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const E2E_DIR = path.resolve(__dirname, "../e2e");

/** The tags that place a test in a tier (`--grep @smoke`, `--grep-invert "@slow|@external"`, nightly = everything). */
const TIER_TAGS =["@smoke", "@regression", "@slow", "@external"] as const;

/** Options that playwright.config.ts sets once for every project. */
const CONFIG_OWNED_OPTIONS = ["navigationTimeout", "actionTimeout", "screenshot", "trace", "video"];

/** Helpers that live in `helpers/` and must not be written again in a spec. */
const SHARED_HELPER_NAMES = ["createDomain", "createProduct", "createEventFromMenu", "RAW_DB_TEXT"];

type Kind = "untagged-test" | "sleep" | "network-idle" | "hidden-test" | "config-owned-use" | "local-helper";

interface Problem {
  kind: Kind;
  file: string;
  line: number;
  message: string;
}

const isStringLike = (node: ts.Node | undefined): boolean =>
  !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node));

/** The string literals of a `tag:` value: `"@smoke"` or `["@smoke", "@slow"]`; undefined when it is not a literal. */
function literalTags(value: ts.Expression): string[] | undefined {
  if (ts.isStringLiteralLike(value)) return [value.text];
  if (ts.isArrayLiteralExpression(value) && value.elements.every((e) => ts.isStringLiteralLike(e))) {
    return value.elements.map((e) => (e as ts.StringLiteralLike).text);
  }
  return undefined;
}

function propertyNames(object: ts.ObjectLiteralExpression): string[] {
  return object.properties.flatMap((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : []));
}

/** Everything the guard rules object to in one source file. `insideHelpers` exempts the shared-helper definitions (rule e). */
function scanSource(file: string, source: string, insideHelpers = false): Problem[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: Problem[] = [];
  const add = (kind: Kind, node: ts.Node, message: string) =>
    problems.push({ kind, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, message });
  const titleOf = (call: ts.CallExpression) => call.arguments[0]?.getText(sf).slice(0, 70) ?? "(no title)";

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);

      if (callee === "test") {
        const details = node.arguments[1];
        if (!details || !ts.isObjectLiteralExpression(details)) {
          add("untagged-test", node, `${titleOf(node)} has no details object: use test(name, { tag: ["@regression"] }, fn)`);
        } else {
          const tag = details.properties.find(
            (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "tag",
          );
          const tags = tag ? literalTags(tag.initializer) : undefined;
          if (!tag) add("untagged-test", node, `${titleOf(node)} has no tag: add { tag: ["@regression"] } (one of ${TIER_TAGS.join(", ")})`);
          else if (!tags) add("untagged-test", node, `${titleOf(node)}: write the tags as string literals, so they can be checked`);
          else if (!tags.some((t) => (TIER_TAGS as readonly string[]).includes(t))) {
            add("untagged-test", node, `${titleOf(node)} has the tags ${tags.join(", ")} but no tier tag (${TIER_TAGS.join(", ")})`);
          }
        }
      }

      if (/\.waitForTimeout$/.test(callee)) add("sleep", node, `${callee}(...): wait for a state of the page with a web-first assertion instead`);
      if (/\.waitForLoadState$/.test(callee) && node.arguments[0]?.getText(sf).includes("networkidle")) {
        add("network-idle", node, `${callee}("networkidle"): wait for what the page shows instead`);
      }

      if (/^test(\.describe)?\.(skip|fixme)$/.test(callee)) {
        const [first, second] = node.arguments;
        if (!first) add("hidden-test", node, `${callee}() hides a test without a reason`);
        else if (isStringLike(first)) {
          if (!/\[[^\]]+\]/.test(first.getText(sf))) add("hidden-test", node, `${callee}(${titleOf(node)}) lacks a bracketed reason in its title, e.g. [TRACKED: why]`);
        } else if (!isStringLike(second)) {
          add("hidden-test", node, `${callee}(${first.getText(sf).slice(0, 40)}) is a conditional skip without a reason string`);
        }
      }

      if (callee === "test.use" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const owned = propertyNames(node.arguments[0]).filter((name) => CONFIG_OWNED_OPTIONS.includes(name));
        if (owned.length > 0) add("config-owned-use", node, `test.use({ ${owned.join(", ")} }): playwright.config.ts sets it once`);
      }
    }

    if (!insideHelpers) {
      const declared =
        (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (declared && SHARED_HELPER_NAMES.includes(declared)) add("local-helper", node, `${declared} is defined here: import the one in helpers/ instead`);
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTs(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const rel = (file: string) => path.relative(path.resolve(__dirname, "../.."), file);
const insideHelpers = (file: string) => file.startsWith(path.join(E2E_DIR, "helpers") + path.sep);

function scanSuite(kinds: Kind[], files: string[]): string[] {
  return files
    .flatMap((file) => scanSource(file, readFileSync(file, "utf8"), insideHelpers(file)))
    .filter((p) => kinds.includes(p.kind))
    .map((p) => `${rel(p.file)}:${p.line}  ${p.message}`);
}

const allFiles = listTs(E2E_DIR);
const specFiles = allFiles.filter((f) => f.endsWith(".spec.ts"));
/** The setup file and the specs are the tests; helpers/ and fixtures/ are scanned for the sleep and helper-definition rules only. */
const suiteFiles = allFiles.filter((f) => f.endsWith(".spec.ts") || f.endsWith(".setup.ts"));
const outsideHelpers = allFiles.filter((f) => !insideHelpers(f));

describe("the browser suite scanner", () => {
  const scan = (src: string, helpers = false) => scanSource("x.spec.ts", src, helpers).map((p) => p.kind);

  it("flags a test without a tier tag and accepts one with a tier tag", () => {
    expect(scan(`test("a", async () => {});`)).toEqual(["untagged-test"]);
    expect(scan(`test("a", { tag: ["@wip"] }, async () => {});`)).toEqual(["untagged-test"]);
    expect(scan(`test("a", { annotation: [] }, async () => {});`)).toEqual(["untagged-test"]);
    expect(scan(`test("a", { tag: TAGS }, async () => {});`)).toEqual(["untagged-test"]);
    expect(scan(`test("a", { tag: ["@smoke"] }, async () => {});`)).toEqual([]);
    expect(scan(`test("a", { tag: ["@regression", "@slow"] }, async () => {});`)).toEqual([]);
    expect(scan("test(`${v.id}`, { tag: '@external' }, async () => {});")).toEqual([]);
  });

  it("does not take describe / step / use / a mention in a comment or string for a test call", () => {
    expect(scan(`test.describe("d", () => { /* test("x") waitForTimeout(1) */ const s = 'test("y")'; });`)).toEqual([]);
    expect(scan(`await test.step("s", async () => {});`)).toEqual([]);
  });

  it("flags sleeps and networkidle waits", () => {
    expect(scan(`await page.waitForTimeout(500);`)).toEqual(["sleep"]);
    expect(scan(`await page.waitForLoadState("networkidle", { timeout: 1 }).catch(() => {});`)).toEqual(["network-idle"]);
    expect(scan(`await page.waitForLoadState("load");`)).toEqual([]);
  });

  it("flags a test that is hidden without a reason", () => {
    expect(scan(`test.fixme("emit", async () => {});`)).toEqual(["hidden-test"]);
    expect(scan(`test.skip("emit", async () => {});`)).toEqual(["hidden-test"]);
    expect(scan(`test.fixme();`)).toEqual(["hidden-test"]);
    expect(scan(`test.skip(!online);`)).toEqual(["hidden-test"]);
    expect(scan(`test.describe.skip("group", () => {});`)).toEqual(["hidden-test"]);
    expect(scan(`test.fixme("emit [TRACKED: no UI yet]", async () => {});`)).toEqual([]);
    expect(scan(`test.skip(!online, "the host is not reachable");`)).toEqual([]);
  });

  it("flags per-spec copies of what the config owns", () => {
    expect(scan(`test.use({ navigationTimeout: 60_000, actionTimeout: 30_000 });`)).toEqual(["config-owned-use"]);
    expect(scan(`test.use({ trace: "on" });`)).toEqual(["config-owned-use"]);
    expect(scan(`test.use({ baseURL: base, storageState: { cookies: [], origins: [] } });`)).toEqual([]);
  });

  it("flags a local copy of a shared helper, but not its definition in helpers/", () => {
    expect(scan(`async function createDomain(page) {}`)).toEqual(["local-helper"]);
    expect(scan(`const createProduct = async () => {};`)).toEqual(["local-helper"]);
    expect(scan(`const RAW_DB_TEXT = /prisma/i;`)).toEqual(["local-helper"]);
    expect(scan(`async function createEventFromMenu() {}`)).toEqual(["local-helper"]);
    expect(scan(`export async function createDomain(page) {}`, true)).toEqual([]);
  });

  it("reads the specs it guards (it cannot pass by finding nothing)", () => {
    expect(specFiles.length).toBeGreaterThanOrEqual(15);
    const calls = specFiles.reduce((n, f) => n + (readFileSync(f, "utf8").match(/^\s*test\(/gm) ?? []).length, 0);
    expect(calls).toBeGreaterThanOrEqual(50);
  });
});

describe("tests/e2e follows the suite rules", () => {
  it("(a) every test carries a tier tag", () => {
    expect(scanSuite(["untagged-test"], suiteFiles)).toEqual([]);
  });

  it("(b) no waitForTimeout sleep and no networkidle wait, in a spec or in a helper", () => {
    expect(scanSuite(["sleep", "network-idle"], allFiles)).toEqual([]);
  });

  it("(c) no test.fixme / test.skip without a reason", () => {
    expect(scanSuite(["hidden-test"], suiteFiles)).toEqual([]);
  });

  it("(d) timeouts, trace and screenshot are set in playwright.config.ts, not per spec", () => {
    expect(scanSuite(["config-owned-use"], suiteFiles)).toEqual([]);
  });

  it("(e) createDomain / createProduct / createEventFromMenu / RAW_DB_TEXT are defined once, in helpers/", () => {
    expect(scanSuite(["local-helper"], outsideHelpers)).toEqual([]);
    // ...and they really are defined there.
    const helperSource = listTs(path.join(E2E_DIR, "helpers")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const name of SHARED_HELPER_NAMES) expect(helperSource, `${name} is not defined in helpers/`).toMatch(new RegExp(`(function|const)\\s+${name}\\b`));
  });
});
