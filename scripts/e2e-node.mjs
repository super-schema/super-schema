// Which Node the browser suite runs on, and one place that says so for both scripts (scripts/e2e-phases.mjs, scripts/e2e-release.mjs).
//
// Why a guard: on Node 26.3.1 (the default of a Homebrew machine) a run of the full regression tier stopped after its last test with every
// Playwright worker idle and never ended (seen four times; never on Node 20.19.4). CI runs Node 22 and the Docker image Node 20, so the
// suite supports `^20.9.0 || ^22.0.0` (package.json `engines`; `.nvmrc` says 22) and a run on another Node is refused before anything is
// provisioned, with the command that fixes it. `E2E_ALLOW_UNSUPPORTED_NODE=1` is the way to try another one anyway (the stall watchdog of
// scripts/e2e-process.mjs still ends a run that hangs).
//
// Dependency-free and pure; unit tested in tests/unit/scripts/e2e-node.test.ts.

/** The escape hatch: a shell value of exactly "1" lets an unsupported Node run the suite. */
export const ALLOW_UNSUPPORTED_NODE = "E2E_ALLOW_UNSUPPORTED_NODE";

/** Node 22, or Node 20 from 20.9 (the oldest Node 20 Next 16 supports). `version` is `process.versions.node` ("22.12.0") or `process.version` ("v22.12.0"). */
export function isSupportedNode(version) {
  const match = /^v?(\d+)\.(\d+)/.exec(String(version));
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major === 22 || (major === 20 && minor >= 9);
}

/**
 * Why this Node cannot run the suite, or null when it can (a supported one, or the escape hatch is set). The text is the whole message:
 * the scripts print it and exit with their usage code (2).
 *
 * @param {{ node: string }} versions `process.versions`
 * @param {Record<string, string | undefined>} env the shell's environment (read before the runner drops its E2E_ names)
 * @returns {string | null}
 */
export function nodeProblem(versions, env) {
  const version = versions.node;
  if (isSupportedNode(version)) return null;
  if (env[ALLOW_UNSUPPORTED_NODE] === "1") return null;
  return (
    `Node ${version} is not supported by this suite (Playwright stalls after the last test on it): run \`nvm use 22\` (or Node 20.9+). ` +
    `${ALLOW_UNSUPPORTED_NODE}=1 runs it anyway; a run that stalls is then ended by the watchdog (E2E_STALL_MS, 5 minutes by default, exit 124).`
  );
}

/**
 * The Node of a run as the headers of the scripts name it: `node v22.12.0`, and when an unsupported one was let through by the
 * escape hatch, that it was.
 *
 * @param {{ node: string }} versions
 * @param {Record<string, string | undefined>} env
 */
export function describeNode(versions, env) {
  const text = `node v${versions.node}`;
  return isSupportedNode(versions.node) ? text : env[ALLOW_UNSUPPORTED_NODE] === "1" ? `${text} (unsupported, let through by ${ALLOW_UNSUPPORTED_NODE}=1)` : text;
}
