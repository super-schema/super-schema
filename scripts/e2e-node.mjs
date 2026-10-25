// Which Node the browser suite runs on: the policy lives in scripts/e2e-node.cjs (CommonJS, so that playwright.config.ts can import the same
// code), and this module is the name the scripts (scripts/e2e-phases.mjs, scripts/e2e-release.mjs) and the tests have always imported it by.
//
// Why a guard: on Node 26.3.1 (the default of a Homebrew machine) a run of the full regression tier stopped after its last test with every
// Playwright worker idle and never ended (seen four times; never on Node 20.19.4). Node 20.9+ and 22 are supported, Node 24 is allowed with a
// warning (untested), the rest is refused with the command that fixes it; `E2E_ALLOW_UNSUPPORTED_NODE=1` is the escape hatch.
//
// Dependency-free and pure; unit tested in tests/unit/scripts/e2e-node.test.ts.

import node from "./e2e-node.cjs";

export const { ALLOW_UNSUPPORTED_NODE, classifyNode, isSupportedNode, isAllowedNode, nodeProblem, nodeWarning, describeNode } = node;
