/**
 * scripts/e2e-node.cjs (re-exported by scripts/e2e-node.mjs): which Node the browser suite runs on. A run on Node 26.3.1 stopped after its last
 * test with every worker idle. The policy: Node 22.22.2 and later supported, Node 24 (the Active LTS, and the Playwright image's) allowed with a
 * one-line warning, everything else refused before anything is provisioned (package.json `engines`, `.nvmrc`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOW_UNSUPPORTED_NODE, classifyNode, describeNode, isAllowedNode, isSupportedNode, nodeProblem, nodeWarning } from "../../../scripts/e2e-node.mjs";

const REPO = path.resolve(__dirname, "../../..");

describe("classifyNode, isSupportedNode, isAllowedNode", () => {
  it("accepts Node 22.22.2 and later in 22 as supported, with or without the v", () => {
    for (const version of ["22.22.2", "v22.22.2", "22.23.0", "v22.30.1"]) {
      expect(classifyNode(version), version).toBe("supported");
      expect(isSupportedNode(version), version).toBe(true);
      expect(isAllowedNode(version), version).toBe(true);
    }
  });

  it("allows Node 24 (the Active LTS) as untested: allowed, not supported", () => {
    for (const version of ["24.0.0", "24.1.0", "v24.11.1"]) {
      expect(classifyNode(version), version).toBe("untested");
      expect(isSupportedNode(version), version).toBe(false);
      expect(isAllowedNode(version), version).toBe(true);
    }
  });

  it("refuses the others: Node 25 and 26 (26.3.1 is the one that stalls), the odd releases between, Node 22 below 22.22.2, and Node 20 (end-of-life)", () => {
    for (const version of ["26.3.1", "26.0.0", "25.9.0", "25.0.0", "23.0.0", "21.7.3", "22.0.0", "22.12.0", "v22.22.1", "20.9.0", "20.8.1", "20.19.4", "v20.10.0", "20.0.0", "18.20.0", "19.9.0", "garbage", ""]) {
      expect(classifyNode(version), version).toBe("unsupported");
      expect(isAllowedNode(version), version).toBe(false);
    }
  });
});

describe("nodeProblem", () => {
  it("is null for a supported or an untested Node, whatever the environment", () => {
    expect(nodeProblem({ node: "22.22.2" }, {})).toBeNull();
    expect(nodeProblem({ node: "22.22.2" }, { E2E_ALLOW_UNSUPPORTED_NODE: "0" })).toBeNull();
    expect(nodeProblem({ node: "24.11.1" }, {})).toBeNull();
  });

  it("names the Node, the reason and the commands that fix it (nvm install 22, 22.22.2 or later)", () => {
    for (const node of ["26.3.1", "25.9.0"]) {
      const problem = nodeProblem({ node }, {});
      expect(problem).toContain(`Node ${node} is not supported by this suite`);
      expect(problem).toContain("`nvm install 22 && nvm use 22`");
      expect(problem).toContain("22.22.2 or later");
      expect(problem).toContain("E2E_ALLOW_UNSUPPORTED_NODE=1");
    }
  });

  it("is lifted by E2E_ALLOW_UNSUPPORTED_NODE=1 and by nothing else (not 'true', not '0', not empty)", () => {
    expect(nodeProblem({ node: "26.3.1" }, { [ALLOW_UNSUPPORTED_NODE]: "1" })).toBeNull();
    for (const value of ["true", "0", "", "yes", "2"]) expect(nodeProblem({ node: "26.3.1" }, { [ALLOW_UNSUPPORTED_NODE]: value }), value).not.toBeNull();
  });

  it("reads the version of process.versions (the object the scripts pass), not of process.version", () => {
    expect(nodeProblem({ node: "20.8.0", v8: "11" } as never, {})).not.toBeNull();
  });
});

describe("nodeWarning", () => {
  it("is one line, only for Node 24, and says it is untested", () => {
    const warning = nodeWarning({ node: "24.1.0" });
    expect(warning).toContain("Node 24.1.0 is untested with this suite");
    expect(warning).not.toContain("\n");
    for (const node of ["22.22.2", "20.19.4", "26.3.1", "25.9.0"]) expect(nodeWarning({ node }), node).toBeNull();
  });
});

describe("describeNode", () => {
  it("is `node v<version>`, says when a Node is untested, and when an unsupported one was let through", () => {
    expect(describeNode({ node: "22.22.2" }, {})).toBe("node v22.22.2");
    expect(describeNode({ node: "24.1.0" }, {})).toBe("node v24.1.0 (untested: the suite is verified on Node 22.22.2 and later)");
    expect(describeNode({ node: "26.3.1" }, { E2E_ALLOW_UNSUPPORTED_NODE: "1" })).toBe("node v26.3.1 (unsupported, let through by E2E_ALLOW_UNSUPPORTED_NODE=1)");
    // refused runs never get to print a header; the plain text is what a caller without the hatch would see
    expect(describeNode({ node: "26.3.1" }, {})).toBe("node v26.3.1");
  });
});

describe("the versions of the repository agree with the guard", () => {
  it(".nvmrc names a Node the suite supports (22.22.2); `engines` admits everything the guard allows and not Node 25+ (the one observed hang is Node 26.3.1)", () => {
    const nvmrc = readFileSync(path.join(REPO, ".nvmrc"), "utf8").trim();
    expect(nvmrc).toBe("22.22.2");
    expect(isSupportedNode(nvmrc)).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { engines?: { node?: string } };
    expect(manifest.engines?.node).toBe(">=22.22.2 <25");
  });

  it("has no bare `test:e2e`: the unguarded `playwright test` is `test:e2e:raw`, and the docs send people to the release scripts", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts).not.toHaveProperty("test:e2e");
    expect(manifest.scripts["test:e2e:raw"]).toBe("playwright test");
    const docs = readFileSync(path.join(REPO, "docs", "testing", "e2e.md"), "utf8");
    expect(docs).toMatch(/test:e2e:release/);
    expect(docs).not.toMatch(/npm run test:e2e(\s|$|`)/m);
  });
});
