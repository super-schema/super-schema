/**
 * tests/e2e/helpers/evidence.ts: the specs that leave files behind (screenshots, the generated text of every target, a step table) write
 * them under ONE directory per run, so two runs at once never write the same files. They wrote to fixed paths under /tmp/e2e-evidence.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evidenceDir } from "../../e2e/helpers/evidence";

const E2E_DIR = path.resolve(__dirname, "../../e2e");

describe("evidenceDir", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is under E2E_EVIDENCE_DIR (the run's own, which the phases script sets), with the segments joined", () => {
    vi.stubEnv("E2E_EVIDENCE_DIR", "/runs/42/test-results/evidence");
    expect(evidenceDir("authored")).toBe(path.join("/runs/42/test-results/evidence", "authored"));
    expect(evidenceDir("lifecycle", "v1")).toBe(path.join("/runs/42/test-results/evidence", "lifecycle", "v1"));
    expect(evidenceDir()).toBe("/runs/42/test-results/evidence");
  });

  it("two runs have two directories: nothing is shared between different values of the variable", () => {
    vi.stubEnv("E2E_EVIDENCE_DIR", "/runs/a/test-results/evidence");
    const a = evidenceDir("A");
    vi.stubEnv("E2E_EVIDENCE_DIR", "/runs/b/test-results/evidence");
    expect(evidenceDir("A")).not.toBe(a);
  });

  it("goes to test-results/e2e-evidence of the working directory without the variable (a bare run), and never to a fixed /tmp path", () => {
    vi.stubEnv("E2E_EVIDENCE_DIR", "");
    expect(evidenceDir("A")).toBe(path.join(process.cwd(), "test-results", "e2e-evidence", "A"));
    expect(evidenceDir("A")).not.toContain("/tmp/e2e-evidence");
  });
});

describe("no spec writes to a fixed, shared path", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? files(full) : /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
    });

  it("nothing under tests/e2e names /tmp/e2e-evidence, a fixed path two runs at once would share (use helpers/evidence.ts)", () => {
    const offenders = files(E2E_DIR)
      .filter((file) => !file.endsWith(path.join("helpers", "evidence.ts")))
      .filter((file) => readFileSync(file, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "").includes("/tmp/e2e-evidence"))
      .map((file) => path.relative(E2E_DIR, file));
    expect(offenders).toEqual([]);
  });

  it("the three specs that leave evidence behind take their directory from the helper", () => {
    for (const spec of ["authored-lifecycle.spec.ts", "jsonschema-lifecycle.spec.ts", "jsonschema-browser-verification.spec.ts"]) {
      expect(readFileSync(path.join(E2E_DIR, spec), "utf8"), spec).toMatch(/evidenceDir\(/);
    }
  });
});
