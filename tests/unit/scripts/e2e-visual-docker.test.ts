import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  DOCKER_HOST_NAME, FIXED_ENVIRONMENT, VISUAL_CONTAINER_PREFIX, dockerVisualArgs, extraMounts, forwardingCommand, hostAccessFor, passedEnvironmentNames,
  visualContainerName, visualImageFor,
} from "../../../scripts/e2e-visual-docker.mjs";
import { parseInDockerArgs, startForwarder } from "../../../scripts/e2e-in-docker.mjs";
import { installedPlaywrightVersion, parseUpdateArgs, releaseArgs } from "../../../scripts/e2e-update-snapshots.mjs";

const ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/dev",
  E2E_BASE_URL: "http://localhost:24001",
  E2E_DATABASE_URL: "postgresql://postgres:secret-pw@127.0.0.1:24002/superschema",
  E2E_API_KEY: "secret-api-key",
  E2E_AUTH_STATE: "/repo/test-results/run-1/tmp/admin.json",
  E2E_OUTPUT_ROOT: "/repo/test-results/run-1",
  E2E_BROWSER_CHANNEL: "chrome",
  DATABASE_URL: "postgresql://postgres:secret-pw@127.0.0.1:24002/superschema",
  DB_PROVIDER: "postgresql",
};
const INPUT = {
  image: "mcr.microsoft.com/playwright:v1.59.1-jammy",
  containerName: "ss-e2e-visual-0a1b2c3d",
  root: "/repo",
  uid: 502,
  gid: 20,
  platform: "darwin",
  env: ENV,
  ports: { app: 24001, db: 24002 },
  command: ["node", "scripts/e2e-phases.mjs", "visual"],
};

/** The values of every `-e NAME=value` pair and the names of every bare `-e NAME`. */
const environmentOf = (args: string[]) => args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []));

describe("the image of the visual tier", () => {
  it("is the official Playwright image of the installed version, to the patch version, on jammy", () => {
    expect(visualImageFor("1.59.1")).toBe("mcr.microsoft.com/playwright:v1.59.1-jammy");
    expect(visualImageFor("1.60.0", "noble")).toBe("mcr.microsoft.com/playwright:v1.60.0-noble");
    for (const bad of ["1.59", "v1.59.1", "latest", "1.59.1-beta", ""]) expect(() => visualImageFor(bad), bad).toThrow(/Playwright version/);
  });

  it("matches the @playwright/test that is installed, so the browsers in the image are the ones that version drives", () => {
    expect(visualImageFor(installedPlaywrightVersion())).toMatch(/^mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-jammy$/);
  });
});

describe("the container's name", () => {
  it("is ss-e2e-visual-<hex>: only containers of the suite carry the prefix the teardown and the docs name", () => {
    expect(visualContainerName("0a1b2c3d")).toBe("ss-e2e-visual-0a1b2c3d");
    expect(VISUAL_CONTAINER_PREFIX.startsWith("ss-e2e-")).toBe(true);
    for (const bad of ["", "xyz", "0A1B", "a b"]) expect(() => visualContainerName(bad), bad).toThrow();
  });
});

describe("how the container reaches the host", () => {
  it("shares the network on Linux and forwards through host.docker.internal on macOS and Windows (never host-gateway: that is the VM, not the host, on Rancher Desktop)", () => {
    expect(hostAccessFor("linux")).toEqual({ network: ["--network", "host"], forward: false });
    for (const platform of ["darwin", "win32"]) expect(hostAccessFor(platform)).toEqual({ network: [], forward: true });
    expect(JSON.stringify(dockerVisualArgs(INPUT))).not.toContain("host-gateway");
    expect(DOCKER_HOST_NAME).toBe("host.docker.internal");
  });

  it("forwards the app's and the database's ports, then runs the command, on macOS", () => {
    const args = dockerVisualArgs(INPUT);
    const imageAt = args.indexOf(INPUT.image);
    expect(args.slice(imageAt + 1)).toEqual(["node", "scripts/e2e-in-docker.mjs", "--forward", "24001,24002", "--target", "host.docker.internal", "--", "node", "scripts/e2e-phases.mjs", "visual"]);
    expect(forwardingCommand({ ports: [1, 2], command: ["x"] })).toEqual(["node", "scripts/e2e-in-docker.mjs", "--forward", "1,2", "--target", "host.docker.internal", "--", "x"]);
  });

  it("runs the command as it is, on the host's network, on Linux", () => {
    const args = dockerVisualArgs({ ...INPUT, platform: "linux" });
    expect(args.slice(args.indexOf(INPUT.image) + 1)).toEqual(INPUT.command);
    expect(args.join(" ")).toContain("--network host");
  });
});

describe("docker run for the browser run", () => {
  it("is removed when it ends, named, labelled as the suite's, and run as the host user so no file of the checkout becomes root's", () => {
    const args = dockerVisualArgs(INPUT);
    expect(args.slice(0, 7)).toEqual(["run", "--rm", "--name", "ss-e2e-visual-0a1b2c3d", "--label", "ss-e2e=1", "--label"]);
    expect(args).toContain("ss-e2e-visual=1");
    expect(args[args.indexOf("--user") + 1]).toBe("502:20");
    expect(args[args.indexOf("--ipc") + 1]).toBe("host");
  });

  it("mounts the checkout at its own host path and works there, so every path of the run's environment is valid inside", () => {
    const args = dockerVisualArgs(INPUT);
    expect(args[args.indexOf("-v") + 1]).toBe("/repo:/repo");
    expect(args[args.indexOf("-w") + 1]).toBe("/repo");
  });

  it("mounts a node_modules outside the checkout read-only and an output root outside it read-write, each at its own path", () => {
    const mounts = extraMounts({ root: "/work/repo", outputRoot: "/elsewhere/out", nodeModulesTarget: "/work/main/node_modules" });
    expect(mounts).toEqual([{ path: "/work/main/node_modules", readOnly: true }, { path: "/elsewhere/out", readOnly: false }]);
    expect(extraMounts({ root: "/work/repo", outputRoot: "/work/repo/test-results/run-1", nodeModulesTarget: "/work/repo/node_modules" })).toEqual([]);
    expect(extraMounts({ root: "/work/repo", outputRoot: "/work/repo/out" })).toEqual([]);
    const args = dockerVisualArgs({ ...INPUT, mounts });
    expect(args).toContain("/work/main/node_modules:/work/main/node_modules:ro");
    expect(args).toContain("/elsewhere/out:/elsewhere/out");
  });

  it("passes the E2E_* names, DATABASE_URL and DB_PROVIDER on by NAME, never by value: no secret is in a process list", () => {
    const args = dockerVisualArgs(INPUT);
    expect(JSON.stringify(args)).not.toMatch(/secret-pw|secret-api-key/);
    const names = environmentOf(args);
    for (const name of ["E2E_BASE_URL", "E2E_DATABASE_URL", "E2E_API_KEY", "E2E_AUTH_STATE", "E2E_OUTPUT_ROOT", "DATABASE_URL", "DB_PROVIDER"]) expect(names, name).toContain(name);
    expect(names).not.toContain("PATH");
    expect(names).not.toContain("HOME"); // the host's HOME is not the container's
  });

  it("sets what the image needs whatever the host says: the visual switch, the Node that ships in the image, the bundled Chromium, a home for a user the image does not know", () => {
    const names = environmentOf(dockerVisualArgs(INPUT));
    for (const [name, value] of FIXED_ENVIRONMENT) expect(names).toContain(`${name}=${value}`);
    expect(names).toContain("E2E_VISUAL_IN_DOCKER=1");
    expect(names).toContain("E2E_BROWSER_CHANNEL=chromium");
    // The host's E2E_BROWSER_CHANNEL=chrome is not passed on next to it.
    expect(names).not.toContain("E2E_BROWSER_CHANNEL");
  });

  it("refuses a container that is not named like the suite's", () => {
    expect(() => dockerVisualArgs({ ...INPUT, containerName: "localcloud" })).toThrow(/ss-e2e-visual-/);
  });

  it("lists only what the browser run reads", () => {
    expect(passedEnvironmentNames({ PATH: "/x", E2E_A: "1", E2E_b: "2", DATABASE_URL: "x", DB_PROVIDER: "y", CI: "true", PGPASSWORD: "z", AUTH_SECRET: "s" })).toEqual(["CI", "DATABASE_URL", "DB_PROVIDER", "E2E_A"]);
  });
});

describe("the options of scripts/e2e-update-snapshots.mjs", () => {
  it("updates every snapshot by default, in the visual tier, in the image; --check only compares", () => {
    const image = "mcr.microsoft.com/playwright:v1.59.1-jammy";
    expect(releaseArgs(parseUpdateArgs([]), image)).toEqual(["--tier", "visual", "--docker-image", image, "--", "--update-snapshots=all"]);
    expect(releaseArgs(parseUpdateArgs(["--check"]), image)).toEqual(["--tier", "visual", "--docker-image", image, "--"]);
  });

  it("passes --reuse-build and --output-root to the runner and everything after -- to Playwright", () => {
    const options = parseUpdateArgs(["--reuse-build", "--output-root", "/tmp/out", "--", "--grep", "login", "--retries=0"]);
    expect(releaseArgs(options, "img")).toEqual(["--tier", "visual", "--docker-image", "img", "--reuse-build", "--output-root", "/tmp/out", "--", "--update-snapshots=all", "--grep", "login", "--retries=0"]);
  });

  it("refuses an option it does not know, and one without its value", () => {
    expect(() => parseUpdateArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseUpdateArgs(["--image"])).toThrow(/needs a value/);
    expect(parseUpdateArgs(["--image", "x:1"]).image).toBe("x:1");
  });
});

describe("scripts/e2e-in-docker.mjs", () => {
  it("reads the ports to forward, the target and the command", () => {
    expect(parseInDockerArgs(["--forward", "24001,24002", "--target", "h", "--", "node", "x.mjs", "--flag"])).toEqual({ ports: [24001, 24002], target: "h", command: ["node", "x.mjs", "--flag"] });
    expect(parseInDockerArgs(["--", "echo"])).toEqual({ ports: [], target: "host.docker.internal", command: ["echo"] });
  });

  it("refuses a missing command, a bad port and an unknown option", () => {
    expect(() => parseInDockerArgs(["--forward", "1"])).toThrow(/usage/);
    expect(() => parseInDockerArgs(["--forward", "1", "--"])).toThrow(/usage/);
    expect(() => parseInDockerArgs(["--forward", "0,99999", "--", "x"])).toThrow(/ports/);
    expect(() => parseInDockerArgs(["--bogus", "--", "x"])).toThrow(/unknown option/);
  });

  it("forwards a connection to the target in both directions, and closes both ends together", async () => {
    const received: string[] = [];
    const target = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk.toString());
        socket.write(`echo:${chunk.toString()}`);
      });
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as net.AddressInfo).port;
    const forwarder = await startForwarder({ listenPort: 0, targetHost: "127.0.0.1", targetPort });
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const client = net.connect(forwarder.port, "127.0.0.1", () => client.write("ping"));
        client.on("data", (chunk) => {
          resolve(chunk.toString());
          client.end();
        });
        client.on("error", reject);
      });
      expect(answer).toBe("echo:ping");
      expect(received).toEqual(["ping"]);
    } finally {
      forwarder.close();
      target.close();
    }
  });

  it("closes the client when the target is not there (nothing is left half open)", async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const forwarder = await startForwarder({ listenPort: 0, targetHost: "127.0.0.1", targetPort: deadPort });
    try {
      await new Promise<void>((resolve) => {
        const client = net.connect(forwarder.port, "127.0.0.1");
        client.on("close", () => resolve());
        client.on("error", () => {});
      });
    } finally {
      forwarder.close();
    }
  });
});
