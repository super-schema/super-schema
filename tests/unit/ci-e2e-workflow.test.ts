/**
 * The contract of `.github/workflows/e2e.yml`, read as YAML (nothing runs): the release suite in CI.
 *
 *   - `pull_request`: the smoke tier on three browsers. It is the only job that gates a merge (a maintainer makes its status check
 *     required in the repository settings: docs/testing/e2e.md lists the exact name, and a test below keeps the two in step);
 *   - `schedule` (nightly) and a tag `v*`: the regression tier in four shards, plus `nightly-extra`, which runs what the nightly tier
 *     has and the regression tier has not, and nothing the regression shards already ran;
 *   - `visual` (same events as the two above): the screenshots, whose browser run happens inside the Playwright Docker image
 *     (scripts/e2e-update-snapshots.mjs); it reports like them and is not a required check;
 *   - `workflow_dispatch`: the same by hand, with a `tier` input.
 *
 * What a reviewer would otherwise check by eye on every edit of the workflow: the permissions stay read-only, only first-party actions
 * run, every job has a timeout, uploads and the flaky summary run after a failure too, no secret can be echoed, nothing the event
 * controls is pasted into a shell script, and every `test:e2e:release` command is one that scripts/e2e-release.mjs accepts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_ROWS, collectFlaky, renderSummary } from "../../scripts/ci-flaky-summary.mjs";
import { parseArgs, planRun } from "../../scripts/e2e-release.mjs";

const REPO = path.resolve(__dirname, "../..");
const WORKFLOW_FILE = path.join(REPO, ".github", "workflows", "e2e.yml");
const WORKFLOW_TEXT = readFileSync(WORKFLOW_FILE, "utf8");

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  name?: string;
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string> | string;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[]; include?: Array<Record<string, string>> } };
  env?: Record<string, unknown>;
  services?: unknown;
  steps: Step[];
}
interface Triggers {
  pull_request?: Record<string, unknown> | null;
  schedule: Array<{ cron: string }>;
  push: { tags?: string[]; branches?: string[]; "branches-ignore"?: string[] };
  workflow_dispatch: { inputs: { tier: { type: string; options: string[]; default: string } } };
}
interface Workflow {
  name?: string;
  on: Triggers;
  permissions?: Record<string, string> | string;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  env?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const workflow = parse(WORKFLOW_TEXT) as Workflow;
const jobs = Object.entries(workflow.jobs);
const job = (id: string): Job => workflow.jobs[id];
const stepsOf = (j: Job) => j.steps;
const runs = (j: Job) => j.steps.flatMap((s) => (s.run ? [s.run] : []));
const allRuns = (j: Job) => runs(j).join("\n");
const releaseRuns = (j: Job) => j.steps.filter((s) => s.run?.includes("test:e2e:release"));

/** Where a job decides that it runs, as the text of its `if` (a job without one runs on every event). */
const condition = (j: Job) => j.if ?? "";
const runsOn = (j: Job, event: string) => condition(j) === "" || condition(j).includes(`github.event_name == '${event}'`);

/** The jobs that run the release runner on browsers installed on the machine; `visual` runs its browser in the Playwright image instead. */
const browserJobs = jobs.filter(([id]) => id !== "visual");

/** `uses: owner/name@ref` of every step of every job. */
const used = jobs.flatMap(([, j]) => j.steps.flatMap((s) => (s.uses ? [s.uses] : [])));

/** The only actions the workflow may use: first party, by major version tag (pinning a commit SHA is not possible without the network). */
const ACTION_ALLOW_LIST = ["actions/checkout@v4", "actions/setup-node@v4", "actions/cache@v4", "actions/upload-artifact@v4"];

/** Permissions that may be `write`, with the reason. Empty: nothing in this workflow writes to the repository, an issue or a check. */
const WRITE_ALLOW_LIST: string[] = [];

/** Splits a command line the way a POSIX shell does for what the workflow uses: whitespace, "double" and 'single' quotes. */
function shellSplit(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
    }
  }
  if (started || current) words.push(current);
  return words;
}

/** Every `test:e2e:release` command a job runs, one entry per matrix leg, with the expressions filled in, as the arguments of the runner. */
function releaseInvocations(id: string): Array<{ leg: string; argv: string[] }> {
  const j = job(id);
  const legs: Array<Record<string, string>> = j.strategy?.matrix?.include ?? (j.strategy?.matrix?.shard ? j.strategy.matrix.shard.map((shard) => ({ shard: String(shard) })) : [{}]);
  return legs.flatMap((leg) =>
    releaseRuns(j).map((step) => {
      const line = step.run!.trim().replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_m, key) => String(leg[key]));
      const [, rest] = line.split(/test:e2e:release\s+--\s+/);
      // The npm script is `node scripts/e2e-release.mjs --tier nightly`; what follows `--` comes after that, and a later --tier wins.
      return { leg: JSON.stringify(leg), argv: ["--tier", "nightly", ...shellSplit(rest)] };
    }),
  );
}

describe("e2e.yml: when it runs", () => {
  it("is the workflow `e2e`, apart from ci.yml", () => {
    expect(workflow.name).toBe("e2e");
  });

  it("has the four triggers", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "schedule", "workflow_dispatch"]);
  });

  it("pull_request has no path or branch filter: a required check that does not report would block every pull request it skips", () => {
    const pr = workflow.on.pull_request ?? {};
    for (const key of ["paths", "paths-ignore", "branches", "branches-ignore"]) expect(pr).not.toHaveProperty(key);
  });

  it("schedule has one cron, a fixed minute and hour every day (once a night, UTC)", () => {
    const crons = workflow.on.schedule.map((s) => s.cron);
    expect(crons).toHaveLength(1);
    expect(crons[0]).toMatch(/^([0-5]?\d) ([01]?\d|2[0-3]) \* \* \*$/);
  });

  it("push runs on tags v* only, never on a branch", () => {
    expect(workflow.on.push.tags).toEqual(["v*"]);
    expect(workflow.on.push).not.toHaveProperty("branches");
    expect(workflow.on.push).not.toHaveProperty("branches-ignore");
  });

  it("workflow_dispatch has a tier input: smoke, regression, nightly or visual", () => {
    const tier = workflow.on.workflow_dispatch.inputs.tier;
    expect(tier.type).toBe("choice");
    expect(tier.options).toEqual(["smoke", "regression", "nightly", "visual"]);
    expect(tier.options).toContain(tier.default);
  });

  it("sets CI=true (Playwright's CI reporters, one worker, one retry, forbidOnly)", () => {
    expect(String(workflow.env?.CI)).toBe("true");
  });

  it("cancels an older run of the same pull request, and nothing else", () => {
    expect(workflow.concurrency?.group).toContain("github.ref");
    expect(String(workflow.concurrency?.["cancel-in-progress"])).toMatch(/github\.event_name == 'pull_request'/);
    expect(String(workflow.concurrency?.["cancel-in-progress"])).not.toMatch(/schedule|push|dispatch/);
  });

  it("has the four jobs, and the smoke job is the pull request's", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(["nightly-extra", "regression", "smoke", "visual"]);
    expect(runsOn(job("smoke"), "pull_request")).toBe(true);
    for (const event of ["schedule", "push"]) expect(runsOn(job("smoke"), event)).toBe(false);
    // The tier input, by hand: smoke runs the smoke job only; regression adds the shards; nightly adds the rest.
    expect(condition(job("smoke"))).toContain("inputs.tier == 'smoke'");
    expect(condition(job("regression"))).toContain("inputs.tier != 'smoke'");
    expect(condition(job("nightly-extra"))).toContain("inputs.tier == 'nightly'");
    // The screenshots: with the nightly tier, or alone.
    expect(condition(job("visual"))).toContain("inputs.tier == 'nightly'");
    expect(condition(job("visual"))).toContain("inputs.tier == 'visual'");
  });

  it("the regression, nightly-extra and visual jobs run on schedule, on a tag, and by hand, never on a pull request", () => {
    for (const id of ["regression", "nightly-extra", "visual"]) {
      expect(runsOn(job(id), "schedule")).toBe(true);
      expect(runsOn(job(id), "push")).toBe(true);
      expect(runsOn(job(id), "workflow_dispatch")).toBe(true);
      expect(runsOn(job(id), "pull_request")).toBe(false);
    }
  });
});

describe("e2e.yml: what a job may do", () => {
  it("the permissions are read-only: contents: read, and a write only from the allow-list", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    const grants = [workflow.permissions, ...jobs.map(([, j]) => j.permissions)].flatMap((p) => (p && typeof p === "object" ? Object.entries(p) : typeof p === "string" ? [["*", p]] : []));
    for (const [scope, level] of grants) {
      expect(level, `${scope}: ${level}`).not.toBe("write-all");
      if (level === "write") expect(WRITE_ALLOW_LIST, `permission ${scope}: write is not on the allow-list`).toContain(scope);
    }
  });

  it("uses only first-party actions, by major version tag", () => {
    expect(used.length).toBeGreaterThan(0);
    for (const action of used) expect(ACTION_ALLOW_LIST, `${action} is not an allowed action`).toContain(action);
    expect(WORKFLOW_TEXT).not.toMatch(/uses:\s*(\.|docker:)/);
  });

  it("names no secret, and never echoes a token", () => {
    expect(WORKFLOW_TEXT).not.toMatch(/\$\{\{\s*secrets\./);
    expect(WORKFLOW_TEXT).not.toMatch(/GITHUB_TOKEN|github\.token/);
    for (const [id, j] of jobs) expect(allRuns(j), `${id} echoes something it should not`).not.toMatch(/echo[^\n]*(secret|token|password)/i);
  });

  it("pastes nothing into a shell script but the matrix (static values): no event field, branch name or input", () => {
    for (const [id, j] of jobs) {
      for (const script of runs(j)) {
        for (const [, expression] of script.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) {
          expect(expression, `${id}: \${{ ${expression} }} in a run script`).toMatch(/^matrix\.\w+$/);
        }
      }
    }
  });

  it("has no services block: the release runner starts its own throwaway PostgreSQL with docker (ubuntu-latest has Docker)", () => {
    for (const [id, j] of jobs) {
      expect(j["runs-on"], id).toBe("ubuntu-latest");
      expect(j.services, id).toBeUndefined();
    }
    expect(WORKFLOW_TEXT).toMatch(/docker/i);
  });

  it("every job has a timeout: smoke 25, a regression shard 60, nightly-extra 90, visual 30 minutes", () => {
    for (const [id, j] of jobs) expect(typeof j["timeout-minutes"], `${id} has no timeout-minutes`).toBe("number");
    expect(job("smoke")["timeout-minutes"]).toBe(25);
    expect(job("regression")["timeout-minutes"]).toBe(60);
    expect(job("nightly-extra")["timeout-minutes"]).toBe(90);
    expect(job("visual")["timeout-minutes"]).toBe(30);
  });
});

describe("e2e.yml: the steps every job shares", () => {
  const setUp = (j: Job) => {
    const steps = stepsOf(j);
    const at = (predicate: (s: Step) => boolean) => steps.findIndex(predicate);
    return {
      checkout: at((s) => s.uses === "actions/checkout@v4"),
      node: at((s) => s.uses === "actions/setup-node@v4"),
      ci: at((s) => s.run?.trim() === "npm ci"),
      prisma: at((s) => s.run?.trim() === "npx prisma generate"),
      browserCache: at((s) => s.uses === "actions/cache@v4"),
      install: at((s) => !!s.run?.includes("playwright install --with-deps")),
      run: at((s) => !!s.run?.includes("test:e2e:release")),
    };
  };

  it.each(browserJobs.map(([id]) => [id]))("%s: checkout, Node 22 with the npm cache, npm ci, prisma generate, browsers, then the run, in that order", (id) => {
    const j = job(id);
    const at = setUp(j);
    const order = [at.checkout, at.node, at.ci, at.prisma, at.browserCache, at.install, at.run];
    expect(order.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const node = stepsOf(j)[at.node];
    expect(String(node.with?.["node-version"])).toBe("22");
    expect(node.with?.cache).toBe("npm");
  });

  it.each(browserJobs.map(([id]) => [id]))("%s: the browsers are cached by the Playwright version of package-lock.json and the browsers installed", (id) => {
    const j = job(id);
    const cache = stepsOf(j).find((s) => s.uses === "actions/cache@v4")!;
    expect(cache.with?.path).toBe("~/.cache/ms-playwright");
    expect(String(cache.with?.key)).toMatch(/steps\.\w+\.outputs\.version/);
    const versionStepId = /steps\.(\w+)\.outputs\.version/.exec(String(cache.with?.key))![1];
    const versionStep = stepsOf(j).find((s) => s.id === versionStepId);
    expect(versionStep?.run, "the step that reads the version").toContain("package-lock.json");
    expect(versionStep?.run).toContain("@playwright/test");
    expect(stepsOf(j).indexOf(versionStep!)).toBeLessThan(stepsOf(j).indexOf(cache));
    // On a cache hit the browsers are there, the system libraries are not (they are apt packages): install-deps. On a miss: everything.
    const installs = stepsOf(j).filter((s) => s.run?.includes("playwright install"));
    expect(installs.map((s) => s.if)).toEqual(expect.arrayContaining([expect.stringContaining("!= 'true'"), expect.stringContaining("== 'true'")]));
  });

  it("every browser cache key, with the matrix filled in, is a valid key: no space, no comma (legs that install the same browsers share an entry on purpose)", () => {
    for (const [id, j] of browserJobs) {
      const legs: Array<Record<string, string>> = j.strategy?.matrix?.include ?? (j.strategy?.matrix?.shard ? j.strategy.matrix.shard.map((shard) => ({ shard: String(shard) })) : [{}]);
      const cache = stepsOf(j).find((s) => s.uses === "actions/cache@v4")!;
      for (const leg of legs) {
        const key = String(cache.with?.key)
          .replace(/\$\{\{\s*runner\.os\s*\}\}/g, "Linux")
          .replace(/\$\{\{\s*steps\.\w+\.outputs\.version\s*\}\}/g, "1.59.1")
          .replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_m, name) => String(leg[name]));
        expect(key, `${id} ${JSON.stringify(leg)}`).toMatch(/^[A-Za-z0-9._-]+$/);
      }
    }
  });

  it.each(jobs.map(([id]) => [id]))("%s: the checkout does not leave the token in the repository's git config (persist-credentials: false)", (id) => {
    const checkouts = stepsOf(job(id)).filter((s) => s.uses === "actions/checkout@v4");
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) expect(checkout.with?.["persist-credentials"]).toBe(false);
  });

  it("starts with the prerequisite that npm ci must work on the runner, and points at the docs", () => {
    const header = WORKFLOW_TEXT.split("\n").slice(0, 16).join("\n");
    expect(header).toMatch(/# Prerequisite: `npm ci` must succeed on the runner/);
    expect(header).toContain("file:../typespec/packages/*");
    expect(header).toContain("docs/testing/e2e.md");
  });

  it("the smoke job installs Chromium, Firefox and WebKit", () => {
    const install = allRuns(job("smoke"));
    expect(install).toMatch(/playwright install --with-deps chromium firefox webkit/);
    expect(install).toMatch(/playwright install-deps chromium firefox webkit/);
    expect(String(stepsOf(job("smoke")).find((s) => s.uses === "actions/cache@v4")?.with?.key)).toMatch(/chromium-firefox-webkit/);
  });

  it("a regression shard installs Chromium and nothing else", () => {
    const install = allRuns(job("regression"));
    expect(install).toMatch(/playwright install --with-deps chromium$/m);
    expect(install).not.toMatch(/firefox|webkit/);
  });

  it("nightly-extra installs what its leg needs (the matrix names the browsers)", () => {
    expect(allRuns(job("nightly-extra"))).toMatch(/playwright install --with-deps \$\{\{ matrix\.browsers \}\}/);
    expect(String(stepsOf(job("nightly-extra")).find((s) => s.uses === "actions/cache@v4")?.with?.key)).toContain("matrix.browser_key");
    for (const leg of job("nightly-extra").strategy!.matrix!.include!) {
      // The key is the browsers joined with hyphens (a cache key must not contain spaces or commas).
      expect(leg.browser_key).toBe(leg.browsers.split(" ").join("-"));
      // The login (the `setup` project) runs on Chromium whatever the leg tests, so every leg has it.
      expect(leg.browsers.split(" ")).toContain("chromium");
      if (/firefox-smoke/.test(leg.args)) expect(leg.browsers.split(" ")).toContain("firefox");
      if (/webkit-smoke/.test(leg.args)) expect(leg.browsers.split(" ")).toContain("webkit");
    }
  });
});

describe("e2e.yml: the visual job", () => {
  const visual = () => job("visual");
  const run = (name: RegExp) => stepsOf(visual()).find((s) => name.test(s.name ?? ""))!;

  it("installs no browser and caches none: the browser is the Playwright image's (the run is a docker run of it, scripts/e2e-update-snapshots.mjs)", () => {
    expect(allRuns(visual())).not.toMatch(/playwright install/);
    expect(stepsOf(visual()).some((s) => s.uses === "actions/cache@v4")).toBe(false);
  });

  it("pulls the Playwright image of the installed version (the tag of package-lock.json's @playwright/test, on jammy) before the run, through an env var, not a pasted expression", () => {
    const version = stepsOf(visual()).find((s) => s.id === "playwright")!;
    expect(version.run).toContain("package-lock.json");
    expect(version.run).toContain("@playwright/test");
    const pull = run(/Pull the Playwright image/);
    expect(pull.env?.PLAYWRIGHT_VERSION).toBe("${{ steps.playwright.outputs.version }}");
    expect(pull.run).toContain("mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy");
    expect(stepsOf(visual()).indexOf(pull)).toBeLessThan(stepsOf(visual()).findIndex((s) => s.run?.includes("test:e2e:visual")));
  });

  it("compares to the committed snapshots when there are some, and makes the first baseline (and says so) when there are none", () => {
    const check = stepsOf(visual()).find((s) => s.run?.trim() === "npm run test:e2e:visual")!;
    const make = stepsOf(visual()).find((s) => s.run?.trim() === "npm run test:e2e:update-snapshots")!;
    expect(check.if).toBe("steps.snapshots.outputs.present == 'true'");
    expect(make.if).toBe("steps.snapshots.outputs.present != 'true'");
    const probe = run(/Which snapshots there are/);
    expect(probe.run).toContain("tests/e2e/visual.spec.ts-snapshots/*-visual-linux.png");
    expect(probe.run).toContain("::notice");
    expect(probe.run).toContain("e2e-visual-snapshots");
  });

  it("uploads the baseline it made (a first run) for a maintainer to commit, and only then", () => {
    const upload = stepsOf(visual()).find((s) => s.with?.name === "e2e-visual-snapshots")!;
    expect(upload.if).toBe("always() && steps.snapshots.outputs.present != 'true'");
    expect(upload.with?.path).toBe("tests/e2e/visual.spec.ts-snapshots");
    expect(upload.with?.["retention-days"]).toBe(14);
    expect(upload.with?.overwrite).toBe(true);
  });

  it("is reported, not required: nothing hides its failure (no continue-on-error) and the docs say not to require it", () => {
    expect(visual().name).toBe("e2e-visual");
    const docs = readFileSync(path.join(REPO, "docs", "testing", "e2e.md"), "utf8");
    expect(docs).toMatch(/do not require[^.]*`e2e-visual`/i);
  });

  it("the commands it runs are the npm scripts of the visual tier, and they run the release runner with the Playwright image", () => {
    const scripts = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(scripts["test:e2e:visual"]).toBe("node scripts/e2e-update-snapshots.mjs --check");
    expect(scripts["test:e2e:update-snapshots"]).toBe("node scripts/e2e-update-snapshots.mjs");
    const source = readFileSync(path.join(REPO, "scripts", "e2e-update-snapshots.mjs"), "utf8");
    expect(source).toContain('"--tier", "visual"');
    expect(source).toContain('"--docker-image"');
  });
});

describe("e2e.yml: the tiers", () => {
  it("smoke runs `npm run test:e2e:release -- --tier smoke`, which selects Chromium, Firefox and WebKit", () => {
    const [{ argv }] = releaseInvocations("smoke");
    expect(argv.slice(2)).toEqual(["--tier", "smoke"]);
    expect(releaseRuns(job("smoke"))).toHaveLength(1);
  });

  it("regression is four shards that run in spite of each other's failure", () => {
    expect(job("regression").strategy?.["fail-fast"]).toBe(false);
    expect(job("regression").strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    const invocations = releaseInvocations("regression");
    expect(invocations.map((i) => i.argv.slice(2).join(" "))).toEqual([
      "--tier regression --shard 1/4",
      "--tier regression --shard 2/4",
      "--tier regression --shard 3/4",
      "--tier regression --shard 4/4",
    ]);
    expect(releaseRuns(job("regression"))[0].run).toContain("--tier regression --shard ${{ matrix.shard }}/4");
  });

  it("nightly-extra runs what the regression shards do not, and runs none of it twice", () => {
    expect(job("nightly-extra").strategy?.["fail-fast"]).toBe(false);
    const legs = job("nightly-extra").strategy!.matrix!.include!;
    expect(new Set(legs.map((l) => l.part)).size, "every leg has a part name of its own").toBe(legs.length);
    const tiers = releaseInvocations("nightly-extra").map((i) => ({ tier: parseArgs(i.argv).tier, args: parseArgs(i.argv) }));
    // Never the regression tier (the shards run it), and never `nightly` unfiltered (it is regression + the rest): the only ways to
    // get the rest without the regression tests are a grep for the tags the regression tier leaves out, or the smoke projects of the
    // other browsers.
    expect(tiers.map((t) => t.tier)).not.toContain("regression");
    for (const { tier, args } of tiers) {
      if (tier === "nightly" || tier === "serial") expect(args.extra, `--tier ${tier} without --grep "@slow|@external" runs the regression tests again`).toEqual(["--grep", "@slow|@external"]);
      if (tier === "smoke") expect(args.projects.sort()).toEqual(["firefox-smoke", "webkit-smoke"]);
    }
    // `nightly` on its own project: Playwright runs a project's dependencies in full whatever --grep says, so the one project that
    // depends on `chromium` (serial-after) must not be selected with it: it is the `serial` tier's.
    const nightly = tiers.find((t) => t.tier === "nightly")!;
    expect(nightly.args.projects).toEqual(["chromium"]);
    expect(tiers.map((t) => t.tier).sort()).toEqual(["nightly", "serial", "smoke"]);
  });

  it("every release command is one the runner accepts, and plans at least one phase", () => {
    const bins = { prisma: "/repo/node_modules/prisma/build/index.js", next: "/repo/node_modules/next/dist/bin/next" };
    for (const id of Object.keys(workflow.jobs)) {
      for (const { leg, argv } of releaseInvocations(id)) {
        // The plan is about the arguments, not about the Node the test happens to run on (scripts/e2e-node.mjs refuses some; CI's own is 22).
        const plan = planRun(argv, {}, { root: "/repo", tmpdir: "/tmp", bins, nodeVersions: { node: "22.12.0" } });
        expect(plan.phasesArgv.length, `${id} ${leg}`).toBeGreaterThan(0);
      }
    }
  });

  it("the npm scripts the workflow runs exist", () => {
    const scripts = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).scripts as Record<string, string>;
    for (const [, j] of jobs) {
      for (const script of runs(j)) {
        for (const [, name] of script.matchAll(/npm run ([\w:-]+)/g)) expect(scripts, `npm run ${name}`).toHaveProperty(name);
      }
    }
  });
});

describe("e2e.yml: reports", () => {
  const OUTPUT_ROOT = /^\$\{\{ github\.workspace \}\}\/test-results\/ci-[\w-]+(\$\{\{ matrix\.\w+ \}\}|-)*$/;

  it.each(jobs.map(([id]) => [id]))("%s: E2E_OUTPUT_ROOT is a directory of its own under test-results/, which version control ignores", (id) => {
    const j = job(id);
    const root = String(j.env?.E2E_OUTPUT_ROOT);
    expect(root).toMatch(OUTPUT_ROOT);
    expect(root).toContain(`ci-${id}`);
    // Two legs of one job run on two machines, but a person unpacking their artifacts must not mix them up: the leg is in the path.
    if (j.strategy?.matrix) expect(root).toMatch(/matrix\./);
    // No release step overrides it with a place that is not the one the artifacts are taken from.
    for (const step of releaseRuns(j)) expect(step.env?.E2E_OUTPUT_ROOT ?? root).toBe(root);
    expect(readFileSync(path.join(REPO, ".gitignore"), "utf8")).toMatch(/^\/test-results$/m);
  });

  it.each(jobs.map(([id]) => [id]))("%s: uploads the playwright report and the test results (traces, junit, flaky list, server.log), `if: always()`, kept 14 days", (id) => {
    const j = job(id);
    const uploads = stepsOf(j).filter((s) => s.uses === "actions/upload-artifact@v4");
    expect(uploads.filter((u) => u.with?.name !== "e2e-visual-snapshots").length).toBeGreaterThanOrEqual(2);
    for (const upload of uploads) {
      // The snapshots a first run of `visual` made are uploaded only when there are no committed ones: `always()` and that.
      if (upload.with?.name === "e2e-visual-snapshots") expect(upload.if).toBe("always() && steps.snapshots.outputs.present != 'true'");
      else expect(upload.if, `${id}: ${upload.name}`).toBe("always()");
      expect(upload.with?.["retention-days"]).toBe(14);
      // v4 fails on a name that already exists in the run ("Re-run failed jobs" uploads the same names again).
      expect(upload.with?.overwrite, `${id}: ${upload.name} needs overwrite: true`).toBe(true);
      if (upload.with?.name !== "e2e-visual-snapshots") expect(String(upload.with?.path)).toContain("${{ env.E2E_OUTPUT_ROOT }}");
      // Two jobs (or legs) with one artifact name would fail the second upload (actions/upload-artifact@v4).
      expect(String(upload.with?.name)).toContain(id);
      if (j.strategy?.matrix) expect(String(upload.with?.name)).toMatch(/matrix\./);
    }
    const paths = uploads.filter((u) => u.with?.name !== "e2e-visual-snapshots").map((u) => String(u.with?.path)).join("\n");
    expect(paths).toContain("playwright-report");
    expect(paths).toContain("test-results");
    expect(paths).toContain("server.log");
    // They come after the run, so a failure of the run is what they exist for.
    const runAt = stepsOf(j).findIndex((s) => s.run?.includes("test:e2e:release") || s.run?.includes("test:e2e:visual") || s.run?.includes("test:e2e:update-snapshots"));
    for (const upload of uploads) expect(stepsOf(j).indexOf(upload)).toBeGreaterThan(runAt);
    expect(new Set(uploads.map((u) => u.with?.name)).size).toBe(uploads.length);
  });

  it.each(jobs.map(([id]) => [id]))("%s: appends the flaky tests to the job summary, `if: always()`, with a script of the repository", (id) => {
    const j = job(id);
    const step = stepsOf(j).find((s) => s.run?.includes("ci-flaky-summary"));
    expect(step, `${id} has no flaky summary step`).toBeDefined();
    expect(step!.if).toBe("always()");
    expect(step!.run).toContain("scripts/ci-flaky-summary.mjs");
    expect(step!.run).toMatch(/>>\s*"\$GITHUB_STEP_SUMMARY"/);
    expect(String(step!.env?.SUMMARY_TITLE), "the summary names the job or leg it is for").toMatch(id === "smoke" || id === "visual" ? new RegExp(id) : /matrix\./);
  });

  it("the run itself is not hidden by `continue-on-error`: a failed tier fails its job", () => {
    for (const [, j] of jobs) for (const step of j.steps) expect(step).not.toHaveProperty("continue-on-error");
    expect(WORKFLOW_TEXT).not.toMatch(/continue-on-error:\s*true/);
  });
});

describe("scripts/ci-flaky-summary.mjs", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ci-flaky-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const write = (root: string, file: string, content: string) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const FLAKY = [{ project: "chromium", title: "orders | the | table", location: "tests/e2e/a.spec.ts:12", attempts: 2 }];

  it("lists the flaky tests of every phase under the output root, with the phase, and escapes what would break a table", () => {
    const root = path.join(scratch, "with");
    write(root, "test-results/main/flaky-tests.json", JSON.stringify(FLAKY));
    write(root, "test-results/serial/flaky-tests.json", JSON.stringify([{ project: "serial-after", title: "crawl", location: "tests/e2e/navigation.spec.ts:1", attempts: 2 }]));
    const text = renderSummary({ title: "regression 2/4", ...collectFlaky(root) });
    expect(text).toContain("### regression 2/4: flaky tests");
    expect(text).toContain("| main | chromium | orders \\| the \\| table | tests/e2e/a.spec.ts:12 | 2 |");
    expect(text).toContain("| serial | serial-after | crawl |");
    expect(text).toContain("2 test(s) failed and then passed on a retry");
  });

  it("says so when no test was flaky (the reporter writes no file then)", () => {
    const root = path.join(scratch, "without");
    write(root, "test-results/main/junit.xml", "<testsuites/>");
    expect(renderSummary({ title: "smoke", ...collectFlaky(root) })).toContain("No test passed only on a retry.");
    expect(collectFlaky(path.join(scratch, "missing")).rows).toEqual([]);
  });

  it("says that there are no results (not that nothing was flaky) when the root is missing or has no report of any phase", () => {
    const missing = path.join(scratch, "no-such-root");
    const text = renderSummary({ title: "smoke", ...collectFlaky(missing) });
    expect(text).toContain(`No test results found at ${missing} (the run may have failed before tests started).`);
    expect(text).not.toContain("No test passed only on a retry");
    const onlyLog = path.join(scratch, "only-a-log");
    write(onlyLog, "server.log", "Ready");
    expect(collectFlaky(onlyLog).reports).toBe(0);
    expect(renderSummary({ title: "smoke", ...collectFlaky(onlyLog) })).toContain("No test results found at");
    // A root with a junit.xml of a phase did run tests: that one is "nothing flaky", as before.
    const ran = path.join(scratch, "ran");
    write(ran, "test-results/main/junit.xml", "<testsuites/>");
    expect(collectFlaky(ran).reports).toBe(1);
    expect(renderSummary({ title: "smoke", ...collectFlaky(ran) })).toContain("No test passed only on a retry.");
  });

  it(`stops the table at ${MAX_ROWS} rows and says how many more there are`, () => {
    const root = path.join(scratch, "many");
    const rows = Array.from({ length: MAX_ROWS + 50 }, (_unused, i) => ({ project: "chromium", title: `test ${i}`, location: `tests/e2e/a.spec.ts:${i + 1}`, attempts: 2 }));
    write(root, "test-results/main/flaky-tests.json", JSON.stringify(rows));
    const text = renderSummary({ title: "regression 1/4", ...collectFlaky(root) });
    expect(text).toContain(`${MAX_ROWS + 50} test(s) failed and then passed on a retry`);
    expect(text.split("\n").filter((line) => line.startsWith("| main |"))).toHaveLength(MAX_ROWS);
    expect(text).toContain("| main | chromium | test 99 |");
    expect(text).not.toContain("| main | chromium | test 100 |");
    expect(text).toContain("and 50 more");
    // At the cap exactly there is nothing more to say.
    expect(renderSummary({ title: "x", rows: rows.slice(0, MAX_ROWS).map((r) => ({ phase: "main", ...r })) })).not.toContain(" more");
  });

  it("reads the lists of the legs of a job that runs the runner more than once (a root with sub-roots), and not the traces", () => {
    const root = path.join(scratch, "nested");
    write(root, "a/test-results/main/flaky-tests.json", JSON.stringify(FLAKY));
    write(root, "b/test-results/main/flaky-tests.json", JSON.stringify(FLAKY));
    write(root, "b/test-results/main/artifacts/some-test/flaky-tests.json", JSON.stringify(FLAKY));
    expect(collectFlaky(root).rows).toHaveLength(2);
  });

  it("names a list it cannot read and still succeeds", () => {
    const root = path.join(scratch, "broken");
    write(root, "test-results/main/flaky-tests.json", "{ not json");
    const found = collectFlaky(root);
    expect(found.rows).toEqual([]);
    expect(renderSummary({ title: "x", ...found })).toContain("Could not read test-results/main/flaky-tests.json.");
  });

  it("run as a script it prints to stdout from E2E_OUTPUT_ROOT and SUMMARY_TITLE, and exits 0", () => {
    const root = path.join(scratch, "script");
    write(root, "test-results/main/flaky-tests.json", JSON.stringify(FLAKY));
    const result = spawnSync(process.execPath, [path.join(REPO, "scripts", "ci-flaky-summary.mjs")], { env: { ...process.env, E2E_OUTPUT_ROOT: root, SUMMARY_TITLE: "smoke" }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("### smoke: flaky tests");
    expect(result.stdout).toContain("orders \\| the \\| table");
  });

  const script = path.join(REPO, "scripts", "ci-flaky-summary.mjs");
  const withoutRoot = () => {
    const env: NodeJS.ProcessEnv = { ...process.env, SUMMARY_TITLE: "smoke" };
    delete env.E2E_OUTPUT_ROOT;
    return env;
  };

  it("has no default root: without E2E_OUTPUT_ROOT or an argument it reads nothing (not the working directory), says so, and exits 0", () => {
    const cwd = path.join(scratch, "cwd-with-a-list");
    write(cwd, "test-results/main/flaky-tests.json", JSON.stringify(FLAKY));
    const result = spawnSync(process.execPath, [script], { cwd, env: withoutRoot(), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No output root given (set E2E_OUTPUT_ROOT or pass the directory as an argument)");
    expect(result.stdout).not.toContain("orders");
    expect(result.stdout).not.toContain("1 test(s)");
  });

  it("takes the root as an argument, and a root that does not exist is a message, not a failure", () => {
    const root = path.join(scratch, "by-argument");
    write(root, "test-results/main/flaky-tests.json", JSON.stringify(FLAKY));
    const given = spawnSync(process.execPath, [script, root], { env: withoutRoot(), encoding: "utf8" });
    expect(given.status).toBe(0);
    expect(given.stdout).toContain("orders \\| the \\| table");
    const missing = spawnSync(process.execPath, [script, path.join(scratch, "nowhere")], { env: withoutRoot(), encoding: "utf8" });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain("No test results found at");
    expect(missing.stdout).toContain("the run may have failed before tests started");
  });
});

describe("the repository around the workflow", () => {
  it("leaves ci.yml as it was: the unit tests on pglite and postgresql", () => {
    const ci = parse(readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8")) as Workflow;
    expect(ci.name).toBe("CI");
    expect(ci.jobs.test.steps.some((s) => s.run === "npm test")).toBe(true);
    expect(ci.jobs.test.strategy?.matrix).toEqual({ provider: ["pglite", "postgresql"] });
  });

  it("docs/testing/e2e.md names every status check of the workflow, says which one to require, and where the flaky list is", () => {
    const docs = readFileSync(path.join(REPO, "docs", "testing", "e2e.md"), "utf8");
    // The status check of a job is its `name` (the matrix legs' names, with the matrix filled in, for the jobs that have one).
    const checkNames = (id: string) => {
      const j = job(id);
      const legs: Array<Record<string, string>> = j.strategy?.matrix?.include ?? (j.strategy?.matrix?.shard ? j.strategy.matrix.shard.map((shard) => ({ shard: String(shard) })) : [{}]);
      return legs.map((leg) => String(j.name).replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_m, key) => String(leg[key])));
    };
    for (const id of Object.keys(workflow.jobs)) for (const name of checkNames(id)) expect(docs, `docs/testing/e2e.md does not mention the check ${name}`).toContain(name);
    expect(checkNames("smoke")).toEqual(["e2e-smoke"]);
    // The one to require is `e2e-smoke` (the line may wrap between the name and the words), and the others must not be required.
    expect(docs).toMatch(/`e2e-smoke`\s+a\s+required\s+status\s+check/i);
    expect(docs).toMatch(/do not require the `e2e-regression/i);
    expect(docs).toContain("flaky-tests.json");
    expect(docs).toContain("branch protection");
    // Require it only once it has run green; and the counts say what they count.
    expect(docs).toMatch(/only after it has run green once/i);
    expect(docs).toMatch(/do not count the `setup`/i);
  });
});
