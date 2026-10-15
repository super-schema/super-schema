/**
 * `tsp` resolves a library by walking up from its workspace (under os.tmpdir()), so an allowlisted NAME that is not
 * installed in <cwd>/node_modules could be found elsewhere (for example <tmpdir>/node_modules) and its JavaScript
 * would run. `runTypeSpecEmitterFiles` therefore requires every imported library to be installed in the project
 * before it creates a workspace.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as fs, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/lib/db", () => ({ prisma: {} }));
import { runTypeSpecEmitterFiles } from "@/lib/typespec-official/emitter.service";

const planted: string[] = [];
let createdTmpNodeModules = false;
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of planted.splice(0)) rmSync(dir, { recursive: true, force: true });
  const tmpNodeModules = join(tmpdir(), "node_modules");
  if (createdTmpNodeModules) {
    // remove the scope / node_modules directories this test created, but only if nothing else put anything in them
    for (const dir of [join(tmpNodeModules, "@typespec"), tmpNodeModules]) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: false });
      } catch {
        // not empty: somebody else's
      }
    }
    createdTmpNodeModules = false;
  }
});

describe("runTypeSpecEmitterFiles requires imported libraries to be installed", () => {
  it("rejects an allowlisted name that is not installed, before a workspace is created", async () => {
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", 'import "@typespec/zzz-nope";\nmodel A { x: string; }\n', {});
    expect(r).toMatchObject({ success: false, error: { code: "TYPESPEC_IMPORT_NOT_ALLOWED", details: { specifier: "@typespec/zzz-nope" } } });
    expect(!r.success && r.error.message).toContain("not an installed TypeSpec library");
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it("rejects an uninstalled library even when it is imported alongside installed ones", async () => {
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", 'import "@typespec/json-schema";\nimport "@superschema/zzz-nope";\nmodel A {}\n', {});
    expect(r).toMatchObject({ success: false, error: { code: "TYPESPEC_IMPORT_NOT_ALLOWED" } });
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it("does not run a package planted in <tmpdir>/node_modules/@typespec that the workspace would otherwise find", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "f1-marker-")), "MARKER");
    planted.push(join(marker, ".."));
    const name = `f1zzz${Math.random().toString(36).slice(2, 8)}`;
    const tmpNodeModules = join(tmpdir(), "node_modules");
    createdTmpNodeModules = !existsSync(tmpNodeModules);
    const pkg = join(tmpNodeModules, "@typespec", name);
    mkdirSync(pkg, { recursive: true });
    planted.push(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@typespec/${name}`, version: "0.0.0", type: "module", tspMain: "main.tsp", main: "index.mjs" }));
    writeFileSync(join(pkg, "main.tsp"), 'import "./index.mjs";\n');
    writeFileSync(join(pkg, "index.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nexport const $decorators = {};\n`);
    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", `import "@typespec/${name}";\nmodel A { x: string; }\n`, {}, { timeoutMs: 60_000 });
    expect(r).toMatchObject({ success: false, error: { code: "TYPESPEC_IMPORT_NOT_ALLOWED" } });
    expect(existsSync(marker)).toBe(false);
  }, 90_000);

  it("lets installed libraries (including the symlinked governance package) through to the workspace step", async () => {
    vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(new Error("EACCES: stop here"));
    const source = 'import "@typespec/json-schema";\nimport "@typespec/http";\nimport "@superschema/typespec-enterprise";\nmodel A { x: string; }\n';
    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", source, {});
    expect(!r.success && r.error.code).toBe("EMITTER_FAILED");
    expect(!r.success && r.error.message).toContain("EACCES: stop here");
  });
});
