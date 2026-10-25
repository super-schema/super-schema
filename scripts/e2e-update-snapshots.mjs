#!/usr/bin/env node
// The visual tier, from the host: make (or check) the screenshots of tests/e2e/visual.spec.ts inside the official Playwright Docker image.
//
//   node scripts/e2e-update-snapshots.mjs                 take every snapshot again (--update-snapshots=all) and write them to
//                                                         tests/e2e/visual.spec.ts-snapshots/
//   node scripts/e2e-update-snapshots.mjs --check         compare to the committed snapshots; a difference fails, nothing is written
//   npm run test:e2e:update-snapshots                     the first; npm run test:e2e:visual the second
//
// Options: --reuse-build (as the release runner's), --image <name> (another image than the one that matches the installed
// @playwright/test), --output-root <dir>; everything after `--` goes to `playwright test` (--grep "login", --retries=0 ...).
//
// It is the release runner (scripts/e2e-release.mjs --tier visual --docker-image <image>) with the right image: a throwaway PostgreSQL and
// the production app on the host as for every tier, and the browser run, login and the `visual` project, in
// `mcr.microsoft.com/playwright:v<installed version>-jammy` (scripts/e2e-visual-docker.mjs says how the container sees the run). A snapshot
// is only ever made, and only ever compared, in that image: macOS and Linux render the same page differently, and a snapshot made on a
// laptop would fail everywhere else. The image is about 2 GB and is NOT pulled here: `docker pull <image>` once (the runner says the command).
//
// Review what changed (git diff --stat tests/e2e/visual.spec.ts-snapshots, and look at the images) before a commit: a snapshot that changed
// without a change to the product is a flaky page, not a new baseline. docs/testing/e2e.md has the long version.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "./e2e-entry.mjs";
import { visualImageFor } from "./e2e-visual-docker.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPTS_DIR);

export const USAGE = `usage: node scripts/e2e-update-snapshots.mjs [--check] [--reuse-build] [--image <name>] [--output-root <dir>] [-- playwright arguments...]

  (no option)       take every snapshot again, in the Playwright Docker image, and write it to tests/e2e/visual.spec.ts-snapshots/
  --check           only compare to the committed snapshots (a difference fails, nothing is written)
  --reuse-build     skip \`next build\` when .next was built from the same inputs
  --image <name>    use this image instead of mcr.microsoft.com/playwright:v<installed @playwright/test version>-jammy
  --output-root <d> where the reports and server.log go
  --help            this text`;

/**
 * @param {string[]} argv
 * @returns {{ check: boolean, reuseBuild: boolean, image?: string, outputRoot?: string, extra: string[], help: boolean }}
 */
export function parseUpdateArgs(argv) {
  const out = { check: false, reuseBuild: false, image: undefined, outputRoot: undefined, extra: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      out.extra = argv.slice(i + 1);
      break;
    }
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--check") out.check = true;
    else if (arg === "--reuse-build") out.reuseBuild = true;
    else if (arg === "--image") out.image = value();
    else if (arg === "--output-root") out.outputRoot = value();
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown option ${arg} (Playwright's own options go after --)`);
  }
  return out;
}

/**
 * The arguments of the release runner for these options: the visual tier, in the image, updating every snapshot unless `check`.
 *
 * @param {ReturnType<typeof parseUpdateArgs>} options
 * @param {string} image
 */
export function releaseArgs(options, image) {
  return [
    "--tier", "visual",
    "--docker-image", image,
    ...(options.reuseBuild ? ["--reuse-build"] : []),
    ...(options.outputRoot ? ["--output-root", options.outputRoot] : []),
    "--",
    ...(options.check ? [] : ["--update-snapshots=all"]),
    ...options.extra,
  ];
}

/** The version of the @playwright/test installed in `root`. */
export function installedPlaywrightVersion(root = REPO_ROOT) {
  const require = createRequire(path.join(root, "package.json"));
  return require("@playwright/test/package.json").version;
}

async function main() {
  const options = parseUpdateArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const image = options.image ?? visualImageFor(installedPlaywrightVersion());
  const args = releaseArgs(options, image);
  console.log(`[e2e-update-snapshots] ${options.check ? "checking" : "updating"} the visual snapshots in ${image}: node scripts/e2e-release.mjs ${args.join(" ")}`);
  const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, "e2e-release.mjs"), ...args], { stdio: "inherit", cwd: REPO_ROOT });
  // The runner owns the teardown: a signal goes to it, and it ends with its own exit code.
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143))));
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[e2e-update-snapshots] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    },
  );
}
