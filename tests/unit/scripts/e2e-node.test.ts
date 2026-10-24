/**
 * scripts/e2e-node.mjs: which Node the browser suite runs on. A run on Node 26.3.1 stopped after its last test with every worker idle,
 * so the suite supports 20.9+ and 22 (package.json `engines`, `.nvmrc`) and refuses the rest before anything is provisioned.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOW_UNSUPPORTED_NODE, describeNode, isSupportedNode, nodeProblem } from "../../../scripts/e2e-node.mjs";

const REPO = path.resolve(__dirname, "../../..");

describe("isSupportedNode", () => {
  it("accepts Node 22 and Node 20 from 20.9, with or without the v", () => {
    for (const version of ["22.0.0", "22.12.0", "v22.20.1", "20.9.0", "20.19.4", "v20.10.0"]) expect(isSupportedNode(version), version).toBe(true);
  });

  it("refuses the others: the one that stalls (26.3.1), the ones below 20.9, and the majors between and after", () => {
    for (const version of ["26.3.1", "25.9.0", "24.1.0", "23.0.0", "21.7.3", "20.8.1", "20.0.0", "18.20.0", "19.9.0", "garbage", ""]) {
      expect(isSupportedNode(version), version).toBe(false);
    }
  });
});

describe("nodeProblem", () => {
  it("is null for a supported Node, whatever the environment", () => {
    expect(nodeProblem({ node: "22.12.0" }, {})).toBeNull();
    expect(nodeProblem({ node: "20.19.4" }, { E2E_ALLOW_UNSUPPORTED_NODE: "0" })).toBeNull();
  });

  it("names the Node, the reason and the command that fixes it", () => {
    const problem = nodeProblem({ node: "26.3.1" }, {});
    expect(problem).toContain("Node 26.3.1 is not supported by this suite (Playwright stalls after the last test on it)");
    expect(problem).toContain("run `nvm use 22` (or Node 20.9+)");
    expect(problem).toContain("E2E_ALLOW_UNSUPPORTED_NODE=1");
  });

  it("is lifted by E2E_ALLOW_UNSUPPORTED_NODE=1 and by nothing else (not 'true', not '0', not empty)", () => {
    expect(nodeProblem({ node: "26.3.1" }, { [ALLOW_UNSUPPORTED_NODE]: "1" })).toBeNull();
    for (const value of ["true", "0", "", "yes", "2"]) expect(nodeProblem({ node: "26.3.1" }, { [ALLOW_UNSUPPORTED_NODE]: value }), value).not.toBeNull();
  });

  it("reads the version of process.versions (the object the scripts pass), not of process.version", () => {
    expect(nodeProblem({ node: "20.8.0", v8: "11" } as never, {})).not.toBeNull();
  });
});

describe("describeNode", () => {
  it("is `node v<version>`, and says when an unsupported Node was let through", () => {
    expect(describeNode({ node: "22.12.0" }, {})).toBe("node v22.12.0");
    expect(describeNode({ node: "26.3.1" }, { E2E_ALLOW_UNSUPPORTED_NODE: "1" })).toBe("node v26.3.1 (unsupported, let through by E2E_ALLOW_UNSUPPORTED_NODE=1)");
    // refused runs never get to print a header; the plain text is what a caller without the hatch would see
    expect(describeNode({ node: "26.3.1" }, {})).toBe("node v26.3.1");
  });
});

describe("the versions of the repository agree with the guard", () => {
  it(".nvmrc names a Node the guard accepts (22), and package.json `engines` says the same range", () => {
    const nvmrc = readFileSync(path.join(REPO, ".nvmrc"), "utf8").trim();
    expect(nvmrc).toBe("22");
    expect(isSupportedNode(`${nvmrc}.0.0`)).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { engines?: { node?: string } };
    expect(manifest.engines?.node).toBe("^20.9.0 || ^22.0.0");
  });
});
