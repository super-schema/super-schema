/**
 * Guard for the browser suite (tests/e2e): the rules of docs/superpowers/plans/2026-10-23-release-ui-suite.md that a reviewer would
 * otherwise have to check by eye on every new spec. It reads the files as TypeScript syntax (not as text), so a comment or a string
 * that merely mentions `waitForTimeout(` is not an offence and a call spelled over several lines is not missed. Every .ts / .tsx / .js
 * / .mjs file under tests/e2e is read, not only the *.spec.ts ones, and `test` is followed through an import alias
 * (`import { test as setup } from "@playwright/test"`).
 *
 *   a. every `test(...)` call carries a tier tag in its details: `test(name, { tag: ["@regression"] }, fn)`; a test is never both
 *      `@smoke` (about 5 minutes, on every pull request, three browsers) and `@slow` / `@external` (nightly only);
 *   b. no `waitForTimeout(` sleep, no `networkidle` wait and no raw `setTimeout(` sleep anywhere in tests/e2e, helpers included (a
 *      guess about time or about the network, not a state of the page); the few `setTimeout`s that are not sleeps before an assertion
 *      are listed, with their reasons, in RAW_TIMER_ALLOWED below;
 *   c. no `test.fixme` / `test.skip` that hides a test without a reason: a declarative one needs a bracketed reason of some substance in
 *      its title (`test.fixme("title [TRACKED: why]", fn)`), a conditional one (`test.skip(cond, "why")`) needs the reason string;
 *   c2. a test that is EXPECTED to fail or is hidden (`test.fail(` / `test.fixme(` in its body, or a declarative `test.fail|fixme|skip("title", fn)`) names a
 *      known defect in its title: `[KD-001 what is broken]`, and that id is an entry of docs/testing/known-defects.md; an entry
 *      with `status: open` in that file is pinned by at least one such title (`no-test` and `dead-code` entries are documented
 *      defects without a test, said explicitly), and every entry has a status;
 *   d. no `test.use({ navigationTimeout | actionTimeout | screenshot | trace | video })`: playwright.config.ts owns them;
 *   e. no local `createDomain` / `createProduct` (helpers/lifecycle.ts) and no local copy of the other shared helpers
 *      (`createEventFromMenu`, `RAW_DB_TEXT`: helpers/event-builder.ts) outside `helpers/`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const E2E_DIR = path.resolve(__dirname, "../e2e");
const REPO_DIR = path.resolve(__dirname, "../..");

/** The tags that place a test in a tier (`--grep @smoke`, `--grep-invert "@slow|@external"`, nightly = everything). */
const TIER_TAGS = ["@smoke", "@regression", "@slow", "@external"] as const;

/** Tags a smoke test must not carry: smoke runs on every pull request, these run nightly only. */
const NIGHTLY_ONLY_TAGS = ["@slow", "@external"];

/** Options that playwright.config.ts sets once for every project. */
const CONFIG_OWNED_OPTIONS = ["navigationTimeout", "actionTimeout", "screenshot", "trace", "video"];

/** Helpers that live in `helpers/` and must not be written again in a spec. */
const SHARED_HELPER_NAMES = ["createDomain", "createProduct", "createEventFromMenu", "RAW_DB_TEXT"];

/** A test that is expected to fail, or hidden, names its known defect in the title: `[KD-001 what is broken]`. */
const KD_IN_TITLE = /\[(KD-\d{3})\b[^\]]*\]/;
const KNOWN_DEFECTS_FILE = "docs/testing/known-defects.md";

/** A reason in a skip/fixme title must be more than a placeholder: `[x]` and `[todo]` explain nothing. */
const MIN_REASON_LENGTH = 6;

/**
 * The raw `setTimeout(` calls that are allowed in tests/e2e, each at most `count` times in its file, with why. Everything else that
 * waits for time is a web-first assertion (`expect(...)`, `expect.poll`, `toPass`).
 */
const RAW_TIMER_ALLOWED: ReadonlyArray<{ file: string; count: number; reason: string }> = [
  {
    file: "tests/e2e/helpers/lifecycle.ts",
    count: 1,
    reason: "`pollEvery`: the cadence of settlePreview's bounded, unit-tested poll (it takes `wait` as a parameter); not a sleep before an assertion",
  },
  {
    file: "tests/e2e/navigation.spec.ts",
    count: 1,
    reason: "inside `sidebar.evaluate` (in the page): lets React commit after a requestAnimationFrame before the next pass looks for new nodes",
  },
];

type Kind = "untagged-test" | "bad-tiers" | "sleep" | "raw-timer" | "network-idle" | "hidden-test" | "defect-pin" | "config-owned-use" | "local-helper";

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

/** The local names `test` goes by in this file: `test`, and whatever `import { test as X } from "@playwright/test"` renames it to. */
function testNames(sf: ts.SourceFile): string[] {
  const names = new Set(["test"]);
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@playwright/test") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === "test") names.add(element.name.text);
  }
  return [...names];
}

const scriptKindOf = (file: string): ts.ScriptKind =>
  file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(m|c)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;

/** Everything the guard rules object to in one source file. `insideHelpers` exempts the shared-helper definitions (rule e). */
function scanSource(file: string, source: string, insideHelpers = false): Problem[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const problems: Problem[] = [];
  const add = (kind: Kind, node: ts.Node, message: string) =>
    problems.push({ kind, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, message });
  const titleOf = (call: ts.CallExpression) => call.arguments[0]?.getText(sf).slice(0, 70) ?? "(no title)";
  const names = testNames(sf);
  const escaped = names.map((n) => n.replace(/[$]/g, "\\$&")).join("|");
  const skipOrFixme = new RegExp(`^(${escaped})(\\.describe)?\\.(skip|fixme)$`);
  // In a test's body: `fail` / `fixme` (a conditional `skip(cond, "why")` is an environment's reason, not a defect: rule c). Declaratively: all three.
  const markers = new RegExp(`^(${escaped})\\.(fail|fixme)$`);
  const declarative = new RegExp(`^(${escaped})\\.(fail|fixme|skip)$`);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);

      if (names.includes(callee)) {
        const details = node.arguments[1];
        if (!details || !ts.isObjectLiteralExpression(details)) {
          add("untagged-test", node, `${titleOf(node)} has no details object: use ${callee}(name, { tag: ["@regression"] }, fn)`);
        } else {
          const tag = details.properties.find(
            (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "tag",
          );
          const tags = tag ? literalTags(tag.initializer) : undefined;
          if (!tag) add("untagged-test", node, `${titleOf(node)} has no tag: add { tag: ["@regression"] } (one of ${TIER_TAGS.join(", ")})`);
          else if (!tags) add("untagged-test", node, `${titleOf(node)}: write the tags as string literals, so they can be checked`);
          else if (!tags.some((t) => (TIER_TAGS as readonly string[]).includes(t))) {
            add("untagged-test", node, `${titleOf(node)} has the tags ${tags.join(", ")} but no tier tag (${TIER_TAGS.join(", ")})`);
          } else if (tags.includes("@smoke") && tags.some((t) => NIGHTLY_ONLY_TAGS.includes(t))) {
            add("bad-tiers", node, `${titleOf(node)} is tagged @smoke and ${tags.filter((t) => NIGHTLY_ONLY_TAGS.includes(t)).join("/")}: smoke runs on every pull request, slow and external tests nightly only`);
          }
        }
      }

      // A test that is expected to fail or is hidden (in its body, or declaratively) is pinned to a known defect by its title.
      if (names.includes(callee)) {
        const body = node.arguments[node.arguments.length - 1];
        const title = node.arguments[0] && isStringLike(node.arguments[0]) ? node.arguments[0].getText(sf) : "";
        let marks = false;
        const find = (inner: ts.Node): void => {
          if (ts.isCallExpression(inner) && markers.test(inner.expression.getText(sf))) marks = true;
          if (!ts.isFunctionLike(inner) || inner === body) ts.forEachChild(inner, find);
        };
        if (body && ts.isFunctionLike(body)) find(body);
        if (marks && !KD_IN_TITLE.test(title)) {
          add("defect-pin", node, `${titleOf(node)} is expected to fail or hidden: put its known defect in the title, [KD-001 what is broken] (${KNOWN_DEFECTS_FILE})`);
        }
      }
      if (declarative.test(callee) && node.arguments[0] && isStringLike(node.arguments[0]) && !KD_IN_TITLE.test(node.arguments[0].getText(sf))) {
        add("defect-pin", node, `${callee}(${titleOf(node)}) is expected to fail or hidden: put its known defect in the title, [KD-001 what is broken] (${KNOWN_DEFECTS_FILE})`);
      }

      if (/\.waitForTimeout$/.test(callee)) add("sleep", node, `${callee}(...): wait for a state of the page with a web-first assertion instead`);
      if (callee === "setTimeout" || /^(window|globalThis|global)\.setTimeout$/.test(callee)) {
        add("raw-timer", node, `${callee}(...): a sleep; wait for a state with a web-first assertion (or list it in RAW_TIMER_ALLOWED with its reason)`);
      }
      if (/\.waitForLoadState$/.test(callee) && node.arguments[0]?.getText(sf).includes("networkidle")) {
        add("network-idle", node, `${callee}("networkidle"): wait for what the page shows instead`);
      }

      if (skipOrFixme.test(callee)) {
        const [first, second] = node.arguments;
        if (!first) add("hidden-test", node, `${callee}() hides a test without a reason`);
        else if (isStringLike(first)) {
          const reason = /\[([^\]]*)\]/.exec(first.getText(sf))?.[1].trim() ?? "";
          if (reason.length < MIN_REASON_LENGTH) {
            add("hidden-test", node, `${callee}(${titleOf(node)}) lacks a bracketed reason of at least ${MIN_REASON_LENGTH} characters in its title, e.g. [TRACKED: why]`);
          }
        } else if (!isStringLike(second)) {
          add("hidden-test", node, `${callee}(${first.getText(sf).slice(0, 40)}) is a conditional skip without a reason string`);
        }
      }

      if (names.some((n) => callee === `${n}.use`)) {
        const options = node.arguments[0];
        if (options && ts.isObjectLiteralExpression(options)) {
          const owned = propertyNames(options).filter((name) => CONFIG_OWNED_OPTIONS.includes(name));
          if (owned.length > 0) add("config-owned-use", node, `${callee}({ ${owned.join(", ")} }): playwright.config.ts sets it once`);
        }
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

/** The known-defect ids named by the titles of the tests of a source file (`test("... [KD-001 ...] ...", ...)`, `test.fail("[KD-002 ...]", ...)`). */
function pinnedDefectIds(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const names = testNames(sf);
  const callee = new RegExp(`^(${names.map((n) => n.replace(/[$]/g, "\\$&")).join("|")})(\\.(fail|fixme|skip))?$`);
  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callee.test(node.expression.getText(sf)) && node.arguments[0] && isStringLike(node.arguments[0])) {
      const id = KD_IN_TITLE.exec(node.arguments[0].getText(sf))?.[1];
      if (id) ids.push(id);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ids;
}

/** The entries of docs/testing/known-defects.md: `## KD-001: title`, then a `- status: open | no-test | dead-code` line. */
function knownDefects(markdown: string): Array<{ id: string; title: string; status: string | undefined }> {
  const entries: Array<{ id: string; title: string; status: string | undefined }> = [];
  for (const block of markdown.split(/^(?=## KD-\d{3}:)/m).slice(1)) {
    const heading = /^## (KD-\d{3}): (.+)$/m.exec(block);
    if (!heading) continue;
    entries.push({ id: heading[1], title: heading[2].trim(), status: /^- status: (\S+)/m.exec(block)?.[1] });
  }
  return entries;
}

function listSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSource(full);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(REPO_DIR, file).split(path.sep).join("/");
const insideHelpers = (file: string) => file.startsWith(path.join(E2E_DIR, "helpers") + path.sep);

/** The problems of `kinds` in `files`, as `file:line  message` lines; the allowed raw timers are taken out first. */
function scanSuite(kinds: Kind[], files: string[]): string[] {
  const all = files.flatMap((file) => scanSource(file, readFileSync(file, "utf8"), insideHelpers(file)));
  const allowedLeft = new Map(RAW_TIMER_ALLOWED.map((entry) => [entry.file, entry.count]));
  return all
    .filter((p) => kinds.includes(p.kind))
    .filter((p) => {
      if (p.kind !== "raw-timer") return true;
      const left = allowedLeft.get(rel(p.file)) ?? 0;
      if (left === 0) return true;
      allowedLeft.set(rel(p.file), left - 1);
      return false;
    })
    .map((p) => `${rel(p.file)}:${p.line}  ${p.message}`);
}

/** Everything under tests/e2e that is source code: specs, the setup file, helpers, fixtures, reporters. */
const allFiles = listSource(E2E_DIR);
const specFiles = allFiles.filter((f) => /\.spec\.[tj]sx?$/.test(f));
const outsideHelpers = allFiles.filter((f) => !insideHelpers(f));

describe("the browser suite scanner", () => {
  const scan = (src: string, helpers = false, file = "x.spec.ts") => scanSource(file, src, helpers).map((p) => p.kind);

  it("flags a test without a tier tag and accepts one with a tier tag", () => {
    expect(scan(`test("a", async () => {});`)).toEqual(["untagged-test"]);
    expect(scan(`test("a", { tag: ["@wip"] }, async () => {});`)).toEqual(["untagged-test"]);
    expect(scan(`test("a", { annotation: [] }, async () => {});`)).toEqual(["untagged-test"]);
    expect(scan(`test("a", { tag: TAGS }, async () => {});`)).toEqual(["untagged-test"]);
    expect(scan(`test("a", { tag: ["@smoke"] }, async () => {});`)).toEqual([]);
    expect(scan(`test("a", { tag: ["@regression", "@slow"] }, async () => {});`)).toEqual([]);
    expect(scan("test(`${v.id}`, { tag: '@external' }, async () => {});")).toEqual([]);
  });

  it("follows `test` through an import alias, in any kind of file", () => {
    const aliased = `import { test as setup } from "@playwright/test";\n`;
    expect(scan(`${aliased}setup("log in", async () => {});`, false, "auth.setup.ts")).toEqual(["untagged-test"]);
    expect(scan(`${aliased}setup("log in", { tag: ["@smoke"] }, async () => {});`, false, "auth.setup.ts")).toEqual([]);
    expect(scan(`${aliased}setup.use({ trace: "on" });`, false, "auth.setup.ts")).toEqual(["config-owned-use"]);
    expect(scan(`import { test } from "@playwright/test";\ntest("a", async () => {});`, false, "x.js")).toEqual(["untagged-test"]);
    expect(scan(`import { test as base } from "@playwright/test";\nexport const test = base.extend({});`, true, "fixtures.ts")).toEqual([]);
  });

  it("refuses a test that is tagged @smoke and @slow / @external", () => {
    expect(scan(`test("a", { tag: ["@smoke", "@slow"] }, async () => {});`)).toEqual(["bad-tiers"]);
    expect(scan(`test("a", { tag: ["@smoke", "@regression", "@external"] }, async () => {});`)).toEqual(["bad-tiers"]);
    expect(scan(`test("a", { tag: ["@smoke", "@regression"] }, async () => {});`)).toEqual([]);
  });

  it("does not take describe / step / use / a mention in a comment or string for a test call", () => {
    expect(scan(`test.describe("d", () => { /* test("x") waitForTimeout(1) */ const s = 'test("y")'; });`)).toEqual([]);
    expect(scan(`await test.step("s", async () => {});`)).toEqual([]);
  });

  it("flags sleeps, raw timers and networkidle waits", () => {
    expect(scan(`await page.waitForTimeout(500);`)).toEqual(["sleep"]);
    expect(scan(`await new Promise((resolve) => setTimeout(resolve, 200));`)).toEqual(["raw-timer"]);
    expect(scan(`await new Promise((resolve) => window.setTimeout(resolve, 200));`)).toEqual(["raw-timer"]);
    expect(scan(`await page.waitForLoadState("networkidle", { timeout: 1 }).catch(() => {});`)).toEqual(["network-idle"]);
    expect(scan(`await page.waitForLoadState("load");`)).toEqual([]);
  });

  it("flags a test that is hidden without a reason, or with a placeholder for one", () => {
    // (rule c only: that the title also names a known defect is rule c2, below)
    const scanHidden = (src: string) => scan(src).filter((kind) => kind === "hidden-test");
    expect(scanHidden(`test.fixme("emit", async () => {});`)).toEqual(["hidden-test"]);
    expect(scanHidden(`test.skip("emit", async () => {});`)).toEqual(["hidden-test"]);
    expect(scanHidden(`test.fixme();`)).toEqual(["hidden-test"]);
    expect(scanHidden(`test.skip(!online);`)).toEqual(["hidden-test"]);
    expect(scanHidden(`test.describe.skip("group", () => {});`)).toEqual(["hidden-test"]);
    expect(scanHidden(`test.fixme("emit [x]", async () => {});`)).toEqual(["hidden-test"]);
    expect(scanHidden(`test.fixme("emit [todo]", async () => {});`)).toEqual(["hidden-test"]);
    expect(scanHidden(`test.fixme("emit [TRACKED: no UI yet]", async () => {});`)).toEqual([]);
    expect(scanHidden(`test.skip(!online, "the host is not reachable");`)).toEqual([]);
  });

  it("flags a test that is expected to fail or hidden without a known defect in its title", () => {
    const tagged = (title: string, body: string) => `test(${JSON.stringify(title)}, { tag: ["@regression"] }, async () => { ${body} });`;
    expect(scan(tagged("a", `test.fail(true, "why");`))).toEqual(["defect-pin"]);
    expect(scan(tagged("a [open defect]", `test.fail(true, "why");`))).toEqual(["defect-pin"]);
    expect(scan(tagged("a [KD-1 short]", `test.fail(true, "why");`))).toEqual(["defect-pin"]);
    expect(scan(tagged("a [KD-001 the thing is broken]", `test.fail(true, "why");`))).toEqual([]);
    expect(scan(tagged("a", `test.fixme(true, "why");`))).toEqual(["defect-pin"]);
    expect(scan(tagged("a [KD-012 not wired]", `test.fixme(true, "why");`))).toEqual([]);
    expect(scan(`test.fail("a", async () => {});`)).toEqual(["defect-pin"]);
    expect(scan(`test.fail("a [KD-002 broken]", async () => {});`)).toEqual([]);
    expect(scan(`test.skip("emit [KD-003 no UI yet]", async () => {});`)).toEqual([]);
    // A conditional skip is an environment's reason, not a defect: rule c asks for its reason string, nothing more.
    expect(scan(tagged("needs a network", `test.skip(!online, "the host is not reachable");`))).toEqual([]);
  });

  it("reads the known-defect ids named by test titles, and the entries of the known-defects file", () => {
    const source = `test("a [KD-001 x]", { tag: ["@regression"] }, async () => { test.fail(true, "why"); });\ntest.fail("b [KD-002 y]", async () => {});\ntest("c", { tag: ["@regression"] }, async () => {});`;
    expect(pinnedDefectIds("x.spec.ts", source)).toEqual(["KD-001", "KD-002"]);
    expect(knownDefects("# Known defects\n\n## KD-001: first\n- status: open\nmore\n\n## KD-002: second\n- status: no-test\n\n## KD-003: third\nno status here\n")).toEqual([
      { id: "KD-001", title: "first", status: "open" },
      { id: "KD-002", title: "second", status: "no-test" },
      { id: "KD-003", title: "third", status: undefined },
    ]);
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

  it("reads the files it guards (it cannot pass by finding nothing)", () => {
    expect(specFiles.length).toBeGreaterThanOrEqual(15);
    expect(allFiles.some((f) => f.endsWith("auth.setup.ts"))).toBe(true);
    expect(allFiles.some((f) => f.endsWith(path.join("reporters", "flaky-reporter.ts")))).toBe(true);
    const calls = specFiles.reduce((n, f) => n + (readFileSync(f, "utf8").match(/^\s*test\(/gm) ?? []).length, 0);
    expect(calls).toBeGreaterThanOrEqual(50);
  });

  it("lists every allowed raw timer with a reason, and each of them is really there", () => {
    for (const entry of RAW_TIMER_ALLOWED) {
      expect(entry.reason.length, `${entry.file} needs a reason`).toBeGreaterThan(20);
      const found = scanSource(entry.file, readFileSync(path.join(REPO_DIR, entry.file), "utf8")).filter((p) => p.kind === "raw-timer");
      expect(found.length, `${entry.file} no longer has the setTimeout it is allowed: remove the entry`).toBe(entry.count);
    }
  });
});

describe("tests/e2e follows the suite rules", () => {
  it("(a) every test carries a tier tag, and none is both smoke and nightly-only", () => {
    expect(scanSuite(["untagged-test", "bad-tiers"], allFiles)).toEqual([]);
  });

  it("(b) no waitForTimeout sleep, networkidle wait or raw setTimeout, in a spec or in a helper", () => {
    expect(scanSuite(["sleep", "network-idle", "raw-timer"], allFiles)).toEqual([]);
  });

  it("(c) no test.fixme / test.skip without a reason", () => {
    expect(scanSuite(["hidden-test"], allFiles)).toEqual([]);
  });

  describe("(c2) known defects", () => {
    const entries = knownDefects(readFileSync(path.join(REPO_DIR, KNOWN_DEFECTS_FILE), "utf8"));
    const pins = allFiles.flatMap((file) => pinnedDefectIds(file, readFileSync(file, "utf8")));

    it("every test that is expected to fail or hidden names a known defect in its title", () => {
      expect(scanSuite(["defect-pin"], allFiles)).toEqual([]);
    });

    it(`every id a test title names is an entry of ${KNOWN_DEFECTS_FILE}`, () => {
      const ids = entries.map((entry) => entry.id);
      for (const id of pins) expect(ids, `${id} is named by a test and is not an entry of ${KNOWN_DEFECTS_FILE}`).toContain(id);
    });

    it("every entry has a unique id and a status: open (pinned by a test), no-test or dead-code (said explicitly)", () => {
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
      for (const entry of entries) {
        expect(["open", "no-test", "dead-code"], `${entry.id} (${entry.title}) needs "- status: open | no-test | dead-code"`).toContain(entry.status);
      }
    });

    it("every `open` entry is pinned by at least one test title", () => {
      for (const entry of entries.filter((e) => e.status === "open")) {
        expect(pins, `${entry.id} (${entry.title}) is open and no test names it: pin one with [${entry.id} ...] or give it status: no-test`).toContain(entry.id);
      }
    });
  });

  it("(d) timeouts, trace and screenshot are set in playwright.config.ts, not per spec", () => {
    expect(scanSuite(["config-owned-use"], allFiles)).toEqual([]);
  });

  it("(e) createDomain / createProduct / createEventFromMenu / RAW_DB_TEXT are defined once, in helpers/", () => {
    expect(scanSuite(["local-helper"], outsideHelpers)).toEqual([]);
    // ...and they really are defined there.
    const helperSource = listSource(path.join(E2E_DIR, "helpers")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const name of SHARED_HELPER_NAMES) expect(helperSource, `${name} is not defined in helpers/`).toMatch(new RegExp(`(function|const)\\s+${name}\\b`));
  });
});
