/**
 * scripts/e2e-browser.cjs decides which browser the suite runs in: the Google Chrome of the machine (`channel: "chrome"`), or the
 * Chromium Playwright downloads. The decision is one pure function (explicit E2E_BROWSER_CHANNEL, then CI, then whether Chrome is there)
 * and is used by three places that must agree: playwright.config.ts, the phases script and the release runner. Pinned here: the
 * decision, where Chrome is looked for, what is printed about the browser, and what playwright.config.ts does with the answer.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_CHANNELS,
  CHANNEL_ENV,
  browserEnv,
  chromeCandidates,
  decideBrowser,
  describeBrowser,
  findChrome,
  parseChannel,
  whichOnPath,
} from "../../../scripts/e2e-browser.cjs";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BUNDLED = "/cache/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

describe("where Chrome is looked for", () => {
  it("is /Applications/Google Chrome.app on macOS, google-chrome and google-chrome-stable (then Playwright's own path) on Linux, nowhere else", () => {
    expect(chromeCandidates("darwin")).toEqual([MAC_CHROME]);
    expect(chromeCandidates("linux")).toEqual(["google-chrome", "google-chrome-stable", "/opt/google/chrome/chrome"]);
    expect(chromeCandidates("win32")).toEqual([]);
    expect(chromeCandidates("freebsd")).toEqual([]);
  });

  it("finds the macOS app when the file is there, and nothing when it is not", () => {
    expect(findChrome({ platform: "darwin", exists: (f: string) => f === MAC_CHROME, which: () => undefined })).toBe(MAC_CHROME);
    expect(findChrome({ platform: "darwin", exists: () => false, which: () => "/usr/bin/google-chrome" })).toBeUndefined();
  });

  it("finds google-chrome, else google-chrome-stable, on the PATH of Linux", () => {
    const which = (name: string) => ({ "google-chrome": "/usr/bin/google-chrome", "google-chrome-stable": "/usr/bin/google-chrome-stable" })[name];
    expect(findChrome({ platform: "linux", exists: () => false, which })).toBe("/usr/bin/google-chrome");
    expect(findChrome({ platform: "linux", exists: () => false, which: (name: string) => (name === "google-chrome-stable" ? "/usr/bin/google-chrome-stable" : undefined) })).toBe(
      "/usr/bin/google-chrome-stable",
    );
  });

  it("finds the file Playwright launches on Linux when no command is on the PATH, and nothing when there is none", () => {
    expect(findChrome({ platform: "linux", exists: (f: string) => f === "/opt/google/chrome/chrome", which: () => undefined })).toBe("/opt/google/chrome/chrome");
    expect(findChrome({ platform: "linux", exists: () => false, which: () => undefined })).toBeUndefined();
  });

  it("finds nothing on a platform it does not know", () => {
    expect(findChrome({ platform: "win32", exists: () => true, which: () => "/x/google-chrome" })).toBeUndefined();
  });

  it("looks a command up on the PATH, in order, and returns the first file that exists", () => {
    const present = new Set(["/b/google-chrome", "/c/google-chrome"]);
    const exists = (file: string) => present.has(file);
    expect(whichOnPath("google-chrome", { env: { PATH: ["/a", "/b", "/c"].join(path.delimiter) }, exists })).toBe(path.join("/b", "google-chrome"));
    expect(whichOnPath("google-chrome-stable", { env: { PATH: ["/a", "/b"].join(path.delimiter) }, exists })).toBeUndefined();
    expect(whichOnPath("google-chrome", { env: {}, exists })).toBeUndefined();
    expect(whichOnPath("google-chrome", { env: { PATH: "" }, exists })).toBeUndefined();
  });
});

describe("E2E_BROWSER_CHANNEL", () => {
  it("names the variable the config, the phases script and the runner share", () => {
    expect(CHANNEL_ENV).toBe("E2E_BROWSER_CHANNEL");
    expect([...BROWSER_CHANNELS]).toEqual(["chrome", "chromium"]);
  });

  it("is unset when it is missing, empty or blank", () => {
    for (const value of [undefined, "", "   "]) expect(parseChannel(value)).toBeUndefined();
  });

  it("reads chrome and chromium, whatever the case or the padding", () => {
    expect(parseChannel("chrome")).toBe("chrome");
    expect(parseChannel("chromium")).toBe("chromium");
    expect(parseChannel(" Chrome ")).toBe("chrome");
    expect(parseChannel("CHROMIUM")).toBe("chromium");
  });

  it("refuses anything else, and says which values there are (a typo must not fall back to a browser nobody chose)", () => {
    for (const value of ["firefox", "msedge", "chrome-beta", "1", "true"]) {
      expect(() => parseChannel(value), value).toThrow(/E2E_BROWSER_CHANNEL/);
      expect(() => parseChannel(value), value).toThrow(/chrome.*chromium/);
    }
  });
});

describe("the decision", () => {
  const decide = (env: Record<string, string | undefined>, ci: boolean, chromePath?: string) => decideBrowser({ env, ci, chromePath });

  it("is Chrome on a developer's machine that has it", () => {
    expect(decide({}, false, MAC_CHROME)).toMatchObject({ channel: "chrome", source: "auto", chromePath: MAC_CHROME });
  });

  it("falls back to the bundled Chromium when the machine has no Chrome, and says why", () => {
    const decision = decide({}, false, undefined);
    expect(decision).toMatchObject({ channel: "chromium", source: "auto", chromePath: undefined });
    expect(decision.reason).toMatch(/Chrome was not found/);
    expect(decision.problem).toBeUndefined();
  });

  it("is the bundled Chromium on CI, even when Chrome is installed there (CI keeps the browser it has always run)", () => {
    expect(decide({}, true, "/usr/bin/google-chrome")).toMatchObject({ channel: "chromium", source: "ci", chromePath: undefined });
  });

  it("takes an explicit E2E_BROWSER_CHANNEL over everything: chromium on a machine with Chrome", () => {
    expect(decide({ E2E_BROWSER_CHANNEL: "chromium" }, false, MAC_CHROME)).toMatchObject({ channel: "chromium", source: "env", chromePath: undefined });
  });

  it("takes an explicit chrome over CI: a run that wants Chrome (and CI's retries and reporters) gets both", () => {
    expect(decide({ E2E_BROWSER_CHANNEL: "chrome" }, true, MAC_CHROME)).toMatchObject({ channel: "chrome", source: "env", chromePath: MAC_CHROME });
    expect(decide({ E2E_BROWSER_CHANNEL: "chromium" }, true, MAC_CHROME)).toMatchObject({ channel: "chromium", source: "env" });
  });

  it("does not fall back from an explicit chrome that is not there: it is a problem, in words", () => {
    const decision = decide({ E2E_BROWSER_CHANNEL: "chrome" }, false, undefined);
    expect(decision.channel).toBe("chrome");
    expect(decision.problem).toMatch(/E2E_BROWSER_CHANNEL=chrome/);
    expect(decision.problem).toMatch(/Google Chrome was not found/);
    expect(decision.problem).toMatch(/E2E_BROWSER_CHANNEL=chromium/);
  });

  it("an explicit value that is not a channel is refused, not ignored", () => {
    expect(() => decide({ E2E_BROWSER_CHANNEL: "firefox" }, false, MAC_CHROME)).toThrow(/E2E_BROWSER_CHANNEL/);
  });

  it("gives the Playwright children the channel it decided, under the shared name", () => {
    expect(browserEnv(decide({}, false, MAC_CHROME))).toEqual({ E2E_BROWSER_CHANNEL: "chrome" });
    expect(browserEnv(decide({}, true, MAC_CHROME))).toEqual({ E2E_BROWSER_CHANNEL: "chromium" });
  });
});

describe("what is said about the browser", () => {
  const chrome = decideBrowser({ env: {}, ci: false, chromePath: MAC_CHROME });
  const bundled = decideBrowser({ env: {}, ci: true, chromePath: MAC_CHROME });

  it("is the name and version Chrome reports for itself, and why it was chosen", () => {
    const run = vi.fn(() => "Google Chrome 155.0.8059.85 \n");
    const text = describeBrowser(chrome, { run, bundledExecutable: BUNDLED });
    expect(run).toHaveBeenCalledWith(MAC_CHROME, ["--version"]);
    expect(text).toContain("Google Chrome 155.0.8059.85");
    expect(text).toContain("channel chrome");
    expect(text).toContain(MAC_CHROME);
    expect(text).not.toMatch(/\n/);
  });

  it("is the version of Playwright's bundled build for the Chromium channel, and says it is the bundled one", () => {
    const run = vi.fn(() => "Google Chrome for Testing 147.0.7727.15\n");
    const text = describeBrowser(bundled, { run, bundledExecutable: BUNDLED });
    expect(run).toHaveBeenCalledWith(BUNDLED, ["--version"]);
    expect(text).toContain("Google Chrome for Testing 147.0.7727.15");
    expect(text).toMatch(/bundled/i);
    expect(text).toContain("channel chromium");
  });

  it("says the version could not be read, and why, instead of failing the run", () => {
    const run = () => {
      throw new Error("spawn ENOENT");
    };
    expect(describeBrowser(chrome, { run, bundledExecutable: BUNDLED })).toMatch(/Google Chrome \(version unknown: spawn ENOENT\)/);
    expect(describeBrowser(bundled, { run, bundledExecutable: BUNDLED })).toMatch(/Chromium \(version unknown: spawn ENOENT\)/);
  });

  it("says the bundled Chromium is not installed when Playwright has no path for it", () => {
    const text = describeBrowser(bundled, { run: () => "unused", bundledExecutable: undefined });
    expect(text).toMatch(/not installed/);
    expect(text).toContain("npx playwright install chromium");
  });
});

describe("playwright.config.ts and the channel", () => {
  const saved = { channel: process.env.E2E_BROWSER_CHANNEL, ci: process.env.CI, baseUrl: process.env.E2E_BASE_URL };

  beforeEach(() => {
    vi.resetModules();
    process.env.E2E_BASE_URL = "http://localhost:1"; // no webServer: the config is only read
  });

  afterEach(() => {
    for (const [name, value] of [["E2E_BROWSER_CHANNEL", saved.channel], ["CI", saved.ci], ["E2E_BASE_URL", saved.baseUrl]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  type Project = { name: string; use?: { channel?: string } };
  const projects = async (env: { channel?: string; ci?: string }): Promise<Record<string, Project>> => {
    if (env.channel === undefined) delete process.env.E2E_BROWSER_CHANNEL;
    else process.env.E2E_BROWSER_CHANNEL = env.channel;
    if (env.ci === undefined) delete process.env.CI;
    else process.env.CI = env.ci;
    const config = (await import("../../../playwright.config")).default as { projects: Project[] };
    return Object.fromEntries(config.projects.map((project) => [project.name, project]));
  };

  it("gives chromium, serial-after and a11y the Chrome channel when the channel is chrome, and no other project", async () => {
    const byName = await projects({ channel: "chrome" });
    for (const name of ["chromium", "serial-after", "a11y"]) expect(byName[name].use?.channel, name).toBe("chrome");
    for (const name of ["visual", "firefox-smoke", "webkit-smoke", "setup"]) expect(byName[name].use?.channel, name).toBeUndefined();
  });

  it("keeps the names of the projects (the tiers and the workflow select them by name)", async () => {
    expect(Object.keys(await projects({ channel: "chrome" }))).toEqual(["setup", "chromium", "firefox-smoke", "webkit-smoke", "serial-after", "visual", "a11y"]);
  });

  it("uses the bundled Chromium for every project when the channel is chromium, which also keeps the screenshots of `visual` where they were taken", async () => {
    const byName = await projects({ channel: "chromium" });
    for (const project of Object.values(byName)) expect(project.use?.channel, project.name).toBeUndefined();
  });

  it("uses the bundled Chromium on CI when nothing says otherwise, whether or not Chrome is installed", async () => {
    const byName = await projects({ ci: "1" });
    for (const project of Object.values(byName)) expect(project.use?.channel, project.name).toBeUndefined();
  });

  it("lets an explicit chrome win on CI (the reporters and retries of CI, in Chrome)", async () => {
    const byName = await projects({ channel: "chrome", ci: "1" });
    expect(byName.chromium.use?.channel).toBe("chrome");
    expect(byName.visual.use?.channel).toBeUndefined();
  });

  it("never gives `visual` the channel: its snapshots are taken in the bundled Chromium of the Playwright Docker image", async () => {
    expect((await projects({ channel: "chrome" })).visual.use?.channel).toBeUndefined();
  });

  it("refuses a value that is not a channel", async () => {
    await expect(projects({ channel: "firefox" })).rejects.toThrow(/E2E_BROWSER_CHANNEL/);
  });
});
