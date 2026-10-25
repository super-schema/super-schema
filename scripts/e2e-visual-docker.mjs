// The visual tier's Docker side: what `docker run` of the official Playwright image needs so that the browser run (login, then the
// `visual` project) happens INSIDE the image while the app and its database stay where the release runner (scripts/e2e-release.mjs)
// put them, on the host. Pure and dependency-free; unit tested in tests/unit/scripts/e2e-visual-docker.test.ts. Nothing here runs Docker.
//
// WHY INSIDE THE IMAGE: a screenshot is pixels, and the same page renders differently on macOS and on Linux (fonts, anti-aliasing, the
// browser build). Every snapshot is therefore taken, and every comparison made, by the bundled Chromium of
// `mcr.microsoft.com/playwright:v<the installed @playwright/test version>-jammy`, on a Linux whatever the machine around it is.
//
// HOW THE CONTAINER SEES THE RUN
//   - the repository is mounted at the SAME absolute path it has on the host (`-v <root>:<root>`, `-w <root>`), so every path the runner
//     put in the environment (the output root, the login file) is valid in the container as it stands, and snapshots land in the checkout;
//   - the container user is the host user (`--user uid:gid`): no file in the checkout becomes root's;
//   - the app and the database are on the host's loopback (127.0.0.1:<port>). On macOS and Windows Docker's VM reaches the host as
//     `host.docker.internal`, and nothing is bound to the container's own loopback: scripts/e2e-in-docker.mjs, started first in the
//     container, forwards `127.0.0.1:<port>` there to `host.docker.internal:<port>` (the app and the database), so the browser run
//     uses exactly the URLs it would use on the host (`http://localhost:<app>`, the database at `127.0.0.1:<db>`) and the app's own
//     origin (`AUTH_URL`) is still right. On Linux the container shares the host's network (`--network host`) and nothing is forwarded.
//     (Not `--add-host=host.docker.internal:host-gateway`: on Rancher Desktop that overrides the VM's own mapping of the name with the
//     VM's bridge, which is not the host.)

import path from "node:path";

export const PLAYWRIGHT_IMAGE_REPO = "mcr.microsoft.com/playwright";
/** The distribution of the image the snapshots are made in: part of the tag, so changing it is a decision (every snapshot is redone). */
export const PLAYWRIGHT_IMAGE_DISTRO = "jammy";
/** Every container of the release suite is named with this prefix (and only those are ever removed by it). */
export const VISUAL_CONTAINER_PREFIX = "ss-e2e-visual-";
/** The name docker's VM gives the host on macOS and Windows. */
export const DOCKER_HOST_NAME = "host.docker.internal";

/** `mcr.microsoft.com/playwright:v1.59.1-jammy`: the image that matches an installed @playwright/test, to the patch version. */
export function visualImageFor(playwrightVersion, distro = PLAYWRIGHT_IMAGE_DISTRO) {
  if (!/^\d+\.\d+\.\d+$/.test(playwrightVersion)) throw new Error(`not a Playwright version: "${playwrightVersion}" (the image tag needs MAJOR.MINOR.PATCH)`);
  return `${PLAYWRIGHT_IMAGE_REPO}:v${playwrightVersion}-${distro}`;
}

/** The name of the run's Playwright container: `ss-e2e-visual-<random>`, never one that is not ours. */
export function visualContainerName(randomHex) {
  if (!/^[0-9a-f]{4,}$/.test(randomHex)) throw new Error(`a container name needs a hexadecimal suffix (got "${randomHex}")`);
  return `${VISUAL_CONTAINER_PREFIX}${randomHex}`;
}

/**
 * How a container on this host reaches the app and the database that listen on the host's loopback.
 *
 * @param {string} platform `process.platform`
 * @returns {{ network: string[], forward: boolean }} `network`: the options of `docker run` for it; `forward`: whether the container
 *   has to forward its own loopback ports to `host.docker.internal` (scripts/e2e-in-docker.mjs)
 */
export function hostAccessFor(platform) {
  if (platform === "linux") return { network: ["--network", "host"], forward: false };
  return { network: [], forward: true };
}

/** The in-container command that forwards the ports and then runs `command`. */
export function forwardingCommand({ ports, command, hostName = DOCKER_HOST_NAME }) {
  return ["node", "scripts/e2e-in-docker.mjs", "--forward", ports.map((port) => `${port}`).join(","), "--target", hostName, "--", ...command];
}

/**
 * Where, besides the checkout, the container needs the host's files: a `node_modules` that is a symlink out of the checkout (a git
 * worktree shares the main checkout's) and an output root that is not under the checkout. Each is mounted at its own host path.
 *
 * @param {{ root: string, outputRoot: string, nodeModulesTarget?: string }} input `nodeModulesTarget` is the real path of node_modules
 * @returns {Array<{ path: string, readOnly: boolean }>} absolute host paths, each to be mounted at itself (node_modules read-only, the output root not)
 */
export function extraMounts({ root, outputRoot, nodeModulesTarget }) {
  const outside = (target) => path.relative(root, target).startsWith("..") || path.isAbsolute(path.relative(root, target));
  const mounts = [];
  if (nodeModulesTarget && outside(nodeModulesTarget)) mounts.push({ path: nodeModulesTarget, readOnly: true });
  if (outside(outputRoot)) mounts.push({ path: outputRoot, readOnly: false });
  return mounts;
}

/** The names of the environment variables the browser run is given (their values come from the environment of the `docker` process, never from its arguments). */
export function passedEnvironmentNames(env) {
  return Object.keys(env)
    .filter((name) => /^E2E_[A-Z0-9_]+$/.test(name) || name === "DATABASE_URL" || name === "DB_PROVIDER")
    .sort();
}

/**
 * The arguments of `docker run` for the browser run.
 *
 * @param {{
 *   image: string, containerName: string, root: string, uid: number, gid: number, platform: string,
 *   env: Record<string, string>, command: string[], ports: { app: number, db: number }, mounts?: Array<{ path: string, readOnly: boolean }>,
 * }} input `env` is the environment the browser run would have on the host (only the `E2E_*` names, DATABASE_URL and DB_PROVIDER are
 *   passed on, by name); `command` is what runs in the container, after the forwarding
 * @returns {string[]}
 */
export function dockerVisualArgs({ image, containerName, root, uid, gid, platform, env, command, ports, mounts = [] }) {
  if (!containerName.startsWith(VISUAL_CONTAINER_PREFIX)) throw new Error(`the container is named ${VISUAL_CONTAINER_PREFIX}<id>, not "${containerName}"`);
  const access = hostAccessFor(platform);
  const names = passedEnvironmentNames(env).filter((name) => !FIXED_ENVIRONMENT.some(([fixed]) => fixed === name));
  return [
    "run", "--rm",
    "--name", containerName,
    "--label", "ss-e2e=1",
    "--label", "ss-e2e-visual=1",
    "--user", `${uid}:${gid}`,
    // Chromium shares memory between its processes through /dev/shm: the image's own advice (--ipc=host) rather than a guess at a size.
    "--ipc", "host",
    ...access.network,
    "-v", `${root}:${root}`,
    ...mounts.flatMap((mount) => ["-v", `${mount.path}:${mount.path}${mount.readOnly ? ":ro" : ""}`]),
    "-w", root,
    ...FIXED_ENVIRONMENT.flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    ...names.flatMap((name) => ["-e", name]),
    image,
    ...(access.forward ? forwardingCommand({ ports: [ports.app, ports.db], command }) : command),
  ];
}

/**
 * What the container is told whatever the run says. `E2E_ALLOW_UNSUPPORTED_NODE`: the image ships Node 24, which scripts/e2e-node.mjs
 * does not list (untested, not known broken); Playwright's own image is the Node it supports. `E2E_BROWSER_CHANNEL=chromium`: the image
 * has no Google Chrome and the visual project never takes the channel. `HOME`: the user is the host's, who has no home in the image.
 */
export const FIXED_ENVIRONMENT = [
  ["E2E_VISUAL_IN_DOCKER", "1"],
  ["E2E_ALLOW_UNSUPPORTED_NODE", "1"],
  ["E2E_BROWSER_CHANNEL", "chromium"],
  ["HOME", "/tmp/ss-e2e-home"],
];
