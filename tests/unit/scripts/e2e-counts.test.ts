/**
 * scripts/e2e-counts.mjs: the numbers of the docs (tests per tier) are read from `playwright test --list`, not typed. Pinned: how the JSON list is
 * read (nested describes, a `test.each` at one place, tags, the login project left out), what is counted, the tables, the arguments, and one
 * real listing of the smallest tier.
 */
import { describe, expect, it, vi } from "vitest";
import { COUNTED_TIERS, blockOf, listTier, parseArgs, parseListReport, renderSpecTable, renderTierTable, replaceBlock, specTable, specsOf, summarizeTier } from "../../../scripts/e2e-counts.mjs";

/** The shape of `playwright test --list --reporter=json`. */
const REPORT = {
  suites: [
    {
      title: "auth.setup.ts",
      file: "auth.setup.ts",
      specs: [{ title: "log in once", file: "auth.setup.ts", line: 13, tags: ["smoke", "regression"], tests: [{ projectName: "setup" }] }],
    },
    {
      title: "auth.spec.ts",
      file: "auth.spec.ts",
      specs: [{ title: "a page needs a login", file: "auth.spec.ts", line: 10, tags: ["smoke"], tests: [{ projectName: "chromium" }, { projectName: "firefox-smoke" }] }],
      suites: [
        {
          title: "login form",
          file: "auth.spec.ts",
          specs: [
            { title: "refuses a wrong password", file: "auth.spec.ts", line: 30, tags: ["regression"], tests: [{ projectName: "chromium" }] },
            { title: "slow crawl", file: "auth.spec.ts", line: 40, tags: ["regression", "slow"], tests: [{ projectName: "serial-after" }] },
          ],
          suites: [{ title: "deep", file: "auth.spec.ts", specs: [{ title: "case a", file: "auth.spec.ts", line: 50, tags: ["@regression"], tests: [{ projectName: "chromium" }] }] }],
        },
      ],
    },
    {
      title: "table.spec.ts",
      file: "table.spec.ts",
      specs: [
        // a test.each: three tests at one place, told apart by their titles
        { title: "route /a", file: "table.spec.ts", line: 8, tags: ["regression"], tests: [{ projectName: "chromium" }] },
        { title: "route /b", file: "table.spec.ts", line: 8, tags: ["regression"], tests: [{ projectName: "chromium" }] },
        { title: "route /c", file: "table.spec.ts", line: 8, tags: ["regression"], tests: [{ projectName: "chromium" }] },
      ],
    },
  ],
};

describe("specsOf", () => {
  const tests = specsOf(REPORT);

  it("lists one entry per spec and project, leaving out the login project, with the title path of its describes", () => {
    expect(tests.map((t) => `${t.project}: ${t.title}`)).toEqual([
      "chromium: a page needs a login",
      "firefox-smoke: a page needs a login",
      "chromium: login form > refuses a wrong password",
      "serial-after: login form > slow crawl",
      "chromium: login form > deep > case a",
      "chromium: route /a",
      "chromium: route /b",
      "chromium: route /c",
    ]);
  });

  it("normalizes tags to the @name form, whichever way the reporter wrote them", () => {
    expect(tests.find((t) => t.title.endsWith("case a"))?.tags).toEqual(["@regression"]);
    expect(tests.find((t) => t.title.endsWith("slow crawl"))?.tags).toEqual(["@regression", "@slow"]);
  });

  it("is empty for a report with no suites", () => {
    expect(specsOf({})).toEqual([]);
  });
});

describe("parseListReport", () => {
  it("reads the document even when something was printed before it", () => {
    expect(parseListReport(`warning: something\n${JSON.stringify(REPORT)}`)).toEqual(REPORT);
  });

  it("says so when there is no JSON at all", () => {
    expect(() => parseListReport("Error: no tests found")).toThrow(/printed no JSON/);
  });
});

describe("summarizeTier", () => {
  it("counts runs (test x project), distinct tests (a test.each's three are three), files and runs per project", () => {
    expect(summarizeTier(specsOf(REPORT))).toEqual({
      runs: 8,
      distinct: 7,
      files: 2,
      byProject: { chromium: 6, "firefox-smoke": 1, "serial-after": 1 },
    });
  });
});

describe("specTable", () => {
  const tiers = {
    smoke: specsOf(REPORT).filter((t) => t.tags.includes("@smoke")),
    nightly: specsOf(REPORT),
  };

  it("gives each file its distinct tests, its tags counted once per test, and the tests each tier runs", () => {
    expect(specTable(tiers)).toEqual([
      { file: "auth.spec.ts", tests: 4, tags: { "@regression": 3, "@slow": 1, "@smoke": 1 }, tiers: { smoke: 1, nightly: 4 } },
      { file: "table.spec.ts", tests: 3, tags: { "@regression": 3 }, tiers: { nightly: 3 } },
    ]);
  });

  it("renders the tables the docs quote", () => {
    expect(renderTierTable({ smoke: summarizeTier(tiers.smoke) })).toBe(
      ["| Tier | Runs (test x project) | Distinct tests | Spec files | Runs per project |", "| --- | --- | --- | --- | --- |", "| smoke | 2 | 1 | 1 | chromium 1, firefox-smoke 1 |"].join("\n"),
    );
    const lines = renderSpecTable(specTable(tiers), ["smoke", "nightly"]).split("\n");
    expect(lines[0]).toBe("| Spec | Tests | Tags | smoke runs | nightly runs |");
    expect(lines[2]).toBe("| auth.spec.ts | 4 | @regression 3, @slow 1, @smoke 1 | 1 | 4 |");
    expect(lines[3]).toBe("| table.spec.ts | 3 | @regression 3 | 0 | 3 |");
  });
});

describe("parseArgs", () => {
  it("counts every tier but `serial` (a way of running some of regression and nightly) unless told which", () => {
    expect(COUNTED_TIERS).toEqual(["smoke", "regression", "nightly", "visual"]);
    expect(parseArgs([]).tiers).toEqual(COUNTED_TIERS);
    expect(parseArgs(["--tier", "smoke", "--tier", "nightly", "--json"])).toEqual({ json: true, specs: false, updateMatrix: false, tiers: ["smoke", "nightly"] });
    expect(parseArgs(["--specs"]).specs).toBe(true);
    expect(parseArgs(["--specs", "--update-matrix"]).updateMatrix).toBe(true);
  });

  it("refuses an unknown tier or option, with the usage", () => {
    expect(() => parseArgs(["--tier", "weekly"])).toThrow(/--tier must be one of/);
    expect(() => parseArgs(["--tier", "serial"])).toThrow(/--tier must be one of/);
    expect(() => parseArgs(["--bogus"])).toThrow(/usage: node scripts\/e2e-counts\.mjs/);
    expect(() => parseArgs(["--update-matrix"])).toThrow(/use it with --specs/);
  });
});

describe("blockOf and replaceBlock: the table inside the coverage matrix", () => {
  const doc = "intro\n\n<!-- counts:begin -->\nold table\nline 2\n<!-- counts:end -->\n\n## after\n";

  it("reads the block between the markers, and says nothing when they are missing", () => {
    expect(blockOf(doc, "counts")).toBe("old table\nline 2");
    expect(blockOf("no markers", "counts")).toBeUndefined();
    expect(blockOf("<!-- counts:begin -->\n<!-- counts:end -->", "counts")).toBe("");
  });

  it("replaces only that block, and what is around it stays as it was", () => {
    expect(replaceBlock(doc, "counts", "new table")).toBe("intro\n\n<!-- counts:begin -->\nnew table\n<!-- counts:end -->\n\n## after\n");
    expect(blockOf(replaceBlock(doc, "counts", "a | b\n--- | ---"), "counts")).toBe("a | b\n--- | ---");
    // twice is the same as once
    expect(replaceBlock(replaceBlock(doc, "counts", "x"), "counts", "x")).toBe(replaceBlock(doc, "counts", "x"));
  });

  it("refuses a file that has lost its markers", () => {
    expect(() => replaceBlock("nothing here", "counts", "x")).toThrow(/markers <!-- counts:begin --> and <!-- counts:end --> are not in the file/);
  });
});

describe("listTier", () => {
  it("runs each phase of the tier as the runner plans it, with --list and the JSON reporter, and no server, browser or visual project outside the image", () => {
    const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const run = vi.fn((_command: string, args: string[], env: Record<string, string | undefined>) => {
      calls.push({ args, env });
      return { status: 0, stdout: JSON.stringify(REPORT), stderr: "" };
    });
    const tests = listTier("regression", { run });
    expect(calls).toHaveLength(2); // the regression tier is two phases: the browser projects, then serial-after
    for (const call of calls) {
      expect(call.args).toContain("--list");
      expect(call.args).toContain("--reporter=json");
      expect(call.env.E2E_BASE_URL).toBe("http://127.0.0.1:1");
      expect(call.env.E2E_BROWSER_CHANNEL).toBeTruthy();
      expect(call.env.E2E_VISUAL_IN_DOCKER).toBeUndefined();
    }
    expect(calls[0].args).toContain("--project=chromium");
    expect(calls[1].args).toContain("--project=serial-after");
    expect(tests).toHaveLength(specsOf(REPORT).length * 2);
    listTier("visual", { run });
    expect(calls.at(-1)?.env.E2E_VISUAL_IN_DOCKER).toBe("1");
  });

  it("fails with the reason when Playwright fails", () => {
    const run = () => ({ status: 1, stdout: "", stderr: "Error: browserType.launch" });
    expect(() => listTier("smoke", { run })).toThrow(/playwright --list failed for the smoke tier .*browserType\.launch/);
  });

  it("lists the smoke tier for real: three projects of the same tests, tagged, none of them the login", () => {
    const tests = listTier("smoke");
    const summary = summarizeTier(tests);
    expect(summary.runs).toBeGreaterThan(0);
    expect(Object.keys(summary.byProject).sort()).toEqual(["chromium", "firefox-smoke", "webkit-smoke"]);
    expect(summary.byProject.chromium).toBe(summary.byProject["firefox-smoke"]);
    expect(summary.byProject.chromium).toBe(summary.byProject["webkit-smoke"]);
    expect(summary.distinct).toBe(summary.byProject.chromium);
    expect(tests.every((t) => t.tags.includes("@smoke"))).toBe(true);
  }, 120_000);
});
