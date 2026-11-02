/**
 * scripts/e2e-direct.cjs and playwright.config.ts: what a bare `playwright test` (`npm run test:e2e:raw`, `npx playwright test`) refuses.
 * It has neither the Node guard nor the watchdog of the scripts, and with a dev server on :3000 it would reuse that server and the database
 * of `.env`. The refusals are decided by a pure function (tested with everything injected) and wired into the config (tested by loading it).
 */
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { directRunVerdict, isListeningSync, reuseProblem } from "../../../scripts/e2e-direct.cjs";

const never = () => false;
const always = () => true;
const NODE_26 = { node: "26.3.1" };
const NODE_22 = { node: "22.22.2" };

describe("directRunVerdict: the Node", () => {
  it("refuses an unsupported Node with the commands that fix it", () => {
    const { problem } = directRunVerdict({ versions: NODE_26, env: {}, argv: ["node", "playwright", "test"], listening: never });
    expect(problem).toContain("Node 26.3.1 is not supported by this suite");
    expect(problem).toContain("nvm install 22 && nvm use 22");
    expect(problem).toContain("22.22.2 or later");
  });

  it("lets it through with E2E_ALLOW_UNSUPPORTED_NODE=1", () => {
    expect(directRunVerdict({ versions: NODE_26, env: { E2E_ALLOW_UNSUPPORTED_NODE: "1" }, argv: [], listening: never }).problem).toBeNull();
  });

  it("warns once, in one line, about Node 24 and does not refuse it", () => {
    const verdict = directRunVerdict({ versions: { node: "24.1.0" }, env: {}, argv: [], listening: never });
    expect(verdict.problem).toBeNull();
    expect(verdict.warning).toContain("untested");
    expect(directRunVerdict({ versions: NODE_22, env: {}, argv: [], listening: never })).toEqual({ problem: null, warning: null });
  });

  it("does not refuse a Playwright worker, a listing, or the unit tests that read the config", () => {
    for (const [env, argv] of [
      [{ TEST_WORKER_INDEX: "0" }, []],
      [{}, ["node", "playwright", "test", "--list"]],
      [{ VITEST: "true" }, []],
    ] as const) {
      expect(directRunVerdict({ versions: NODE_26, env, argv: [...argv], listening: always }), JSON.stringify([env, argv])).toEqual({ problem: null, warning: null });
    }
  });
});

describe("directRunVerdict and reuseProblem: a server that is already there", () => {
  it("refuses a run that would reuse a server on :3000, and says what to run instead", () => {
    const { problem } = directRunVerdict({ versions: NODE_22, env: {}, argv: [], listening: always });
    expect(problem).toContain("something already listens on http://localhost:3000");
    expect(problem).toContain("npm run test:e2e:release:smoke");
    expect(problem).toContain("E2E_BASE_URL");
    expect(problem).toContain("E2E_ALLOW_REUSE_SERVER=1");
  });

  it("is lifted by E2E_ALLOW_REUSE_SERVER=1 (on purpose) and by E2E_BASE_URL (a server pointed at is not started or reused)", () => {
    expect(directRunVerdict({ versions: NODE_22, env: { E2E_ALLOW_REUSE_SERVER: "1" }, argv: [], listening: always }).problem).toBeNull();
    expect(directRunVerdict({ versions: NODE_22, env: { E2E_BASE_URL: "http://127.0.0.1:3107" }, argv: [], listening: always }).problem).toBeNull();
    // a value that is not exactly "1" is not the hatch
    expect(directRunVerdict({ versions: NODE_22, env: { E2E_ALLOW_REUSE_SERVER: "true" }, argv: [], listening: always }).problem).not.toBeNull();
  });

  it("asks whether a server is there only when the answer can matter (a probe costs a process)", () => {
    const probe = vi.fn(() => true);
    directRunVerdict({ versions: NODE_22, env: { E2E_BASE_URL: "http://x" }, argv: [], listening: probe });
    directRunVerdict({ versions: NODE_22, env: { E2E_ALLOW_REUSE_SERVER: "1" }, argv: [], listening: probe });
    directRunVerdict({ versions: NODE_26, env: {}, argv: [], listening: probe });
    directRunVerdict({ versions: NODE_22, env: {}, argv: ["--list"], listening: probe });
    expect(probe).not.toHaveBeenCalled();
  });

  it("nothing there, nothing refused", () => {
    expect(directRunVerdict({ versions: NODE_22, env: {}, argv: [], listening: never }).problem).toBeNull();
    expect(reuseProblem({ env: {}, listening: false })).toBeNull();
  });
});

describe("isListeningSync, with a real socket", () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it("is true for a port something listens on, and false for one nothing does", async () => {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    expect(isListeningSync(port)).toBe(true);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    expect(isListeningSync(port)).toBe(false);
  }, 20_000);

  it("is false when the probe cannot run (not knowing is not a refusal)", () => {
    expect(
      isListeningSync(3000, {
        run: () => {
          throw new Error("no spawn");
        },
      }),
    ).toBe(false);
  });
});

describe("playwright.config.ts refuses what the scripts would", () => {
  const NAMES = ["E2E_BASE_URL", "E2E_ALLOW_UNSUPPORTED_NODE", "E2E_ALLOW_REUSE_SERVER", "E2E_BROWSER_CHANNEL", "VITEST", "CI", "E2E_DATABASE_URL", "TEST_WORKER_INDEX"] as const;
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  const realNode = process.versions.node;

  beforeEach(() => {
    vi.resetModules();
    for (const name of NAMES) delete process.env[name]; // VITEST too: the config only refuses outside the unit tests
    process.env.E2E_BASE_URL = "http://localhost:1";
    process.env.E2E_BROWSER_CHANNEL = "chromium";
  });

  afterEach(() => {
    Object.defineProperty(process.versions, "node", { value: realNode, configurable: true, enumerable: true, writable: false });
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  const stubNode = (version: string) => Object.defineProperty(process.versions, "node", { value: version, configurable: true, enumerable: true, writable: false });
  const load = async () => (await import("../../../playwright.config")).default as unknown as { webServer?: { reuseExistingServer: boolean } };

  it("throws on an unsupported Node, naming it and the fix, and loads with the hatch", async () => {
    stubNode("26.3.1");
    await expect(load()).rejects.toThrow(/Node 26\.3\.1 is not supported by this suite.*nvm install 22/);
    vi.resetModules();
    process.env.E2E_ALLOW_UNSUPPORTED_NODE = "1";
    await expect(load()).resolves.toBeDefined();
  });

  it("warns, and loads, on Node 24", async () => {
    stubNode("24.1.0");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(load()).resolves.toBeDefined();
    expect(warn.mock.calls.flat().join("\n")).toContain("Node 24.1.0 is untested");
    warn.mockRestore();
  });

  it("starts its own server and never reuses one unless E2E_ALLOW_REUSE_SERVER=1 says so (E2E_BASE_URL unset, nothing listening is not asserted here)", async () => {
    delete process.env.E2E_BASE_URL;
    process.env.E2E_ALLOW_REUSE_SERVER = "1"; // the probe is skipped: the verdict is about the config's own decision
    expect((await load()).webServer?.reuseExistingServer).toBe(true);
    vi.resetModules();
    delete process.env.E2E_ALLOW_REUSE_SERVER;
    process.env.TEST_WORKER_INDEX = "0"; // a worker: no probe, only the config's value
    expect((await load()).webServer?.reuseExistingServer).toBe(false);
    vi.resetModules();
    process.env.E2E_ALLOW_REUSE_SERVER = "1";
    process.env.E2E_DATABASE_URL = "postgresql://x"; // the release runner's database: never a reused server
    expect((await load()).webServer?.reuseExistingServer).toBe(false);
  });
});

describe("playwright.config.ts: the server of a direct run is migrated before it is built", () => {
  it("generates the client, then runs db:deploy, then builds and starts: the build writes to no database, so this is where a fresh checkout's database is prepared", async () => {
    const savedBaseUrl = process.env.E2E_BASE_URL;
    delete process.env.E2E_BASE_URL; // no external server: the config starts its own
    vi.resetModules();
    try {
      const config = (await import("../../../playwright.config")).default as unknown as { webServer?: { command: string } };
      const command = config.webServer?.command ?? "";
      const at = (step: string) => command.indexOf(step);
      expect(at("npm run db:generate")).toBeGreaterThanOrEqual(0);
      expect(at("npm run db:deploy")).toBeGreaterThan(at("npm run db:generate"));
      expect(at("npm run build")).toBeGreaterThan(at("npm run db:deploy"));
      expect(command.endsWith("npm start")).toBe(true);
    } finally {
      if (savedBaseUrl === undefined) delete process.env.E2E_BASE_URL;
      else process.env.E2E_BASE_URL = savedBaseUrl;
    }
  });
});
