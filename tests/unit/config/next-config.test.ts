import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

describe("next.config — in-process TypeSpec compiler", () => {
  it("keeps @typespec/compiler a server-external package", () => {
    // NodeHost.getJsImport is `import(pathToFileURL(path).href)`. Bundled by Turbopack that is "Cannot find module as
    // expression is too dynamic", and every in-process compile (entity publish regeneration, the TypeSpec tab, the
    // import review) then reports "Failed to load …/tsp-index.js" under `next dev`.
    expect(nextConfig.serverExternalPackages).toContain("@typespec/compiler");
  });

  it("still depends on a runtime-computed import, which is why it cannot be bundled", () => {
    const host = readFileSync(path.join(process.cwd(), "node_modules/@typespec/compiler/dist/src/core/node-host.js"), "utf8");
    // If a compiler upgrade drops the computed import, the external-package entry above can be reconsidered.
    expect(host).toMatch(/getJsImport:\s*\(path\)\s*=>\s*import\(pathToFileURL\(path\)\.href\)/);
  });
});

describe("next.config — the AsyncAPI parser worker", () => {
  it("ships the worker file in the standalone output for every route (the runner forks it by a path no tracer can see through)", () => {
    expect(nextConfig.outputFileTracingIncludes?.["/**"]).toContain("./worker-dist/asyncapi-parser-worker.cjs");
  });

  it("keeps the AsyncAPI preview files in the standalone output", () => {
    expect(nextConfig.outputFileTracingIncludes?.["/api/asyncapi-preview/*"]).toHaveLength(2);
  });

  it("builds the worker before `next dev` and `next build` (npm run build:parser-worker), so nobody has to remember it", () => {
    const scripts = (JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["build:parser-worker"]).toBe("node scripts/build-parser-worker.mjs");
    expect(scripts.predev).toContain("npm run build:parser-worker");
    expect(scripts.prebuild).toContain("npm run build:parser-worker");
  });
});
