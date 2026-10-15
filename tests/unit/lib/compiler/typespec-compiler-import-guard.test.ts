/**
 * C-C1 on the in-process compile path: `compileSource` (behind compileTypeSpecDocument and
 * compileTypeSpecWithGovernance, which serve the Source-tab save, the publish gate, the TypeSpec / OpenAPI importers
 * and the migration service) must refuse a disallowed import BEFORE `compile` runs, and the library-only host must
 * keep a source that somehow got past the guard from running host JavaScript.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
vi.mock("@typespec/compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@typespec/compiler")>();
  return { ...actual, compile: vi.fn(actual.compile) };
});

import { compile, NodeHost } from "@typespec/compiler";
import { compileTypeSpecDocument, compileTypeSpecWithGovernance } from "@/lib/compiler/typespec-compiler";
import { createLibraryOnlyHost } from "@/lib/compiler/library-only-host";
import { TypeSpecImportGuardError } from "@/lib/typespec/import-guard";

let dir: string;
let marker: string;
let script: string;

beforeEach(() => {
  vi.mocked(compile).mockClear();
  dir = mkdtempSync(join(tmpdir(), "f1-compile-"));
  marker = join(dir, "MARKER");
  script = join(dir, "x.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nexport const $decorators = {};\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bypassForms = (path: string): Array<[string, string]> => [
  ["first-line import without a space", `import"${path}";\nmodel A { x: string; }\n`],
  ["import after a closing brace on the same line", `model A { x: string; } import "${path}";\n`],
  ["ordinary absolute import", `import "${path}";\nmodel A { x: string; }\n`],
  ["relative import", `import "./../../../../..${path}";\nmodel A { x: string; }\n`],
  ["import after a block comment", `/* hi */ import "${path}";\nmodel A { x: string; }\n`],
];

describe("compileTypeSpecWithGovernance (Source-tab save, publish gate, migration)", () => {
  it.each(bypassForms("/placeholder"))("rejects %s as a diagnostic and never calls compile", async (_name, template) => {
    const source = template.replaceAll("/placeholder", script);
    const result = await compileTypeSpecWithGovernance(source);
    expect(result.success).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "error", code: "TYPESPEC_IMPORT_NOT_ALLOWED" })]);
    expect(compile).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });

  it("still compiles a legitimate multi-model source with library imports, exactly once", async () => {
    const source = [
      'import "@typespec/http";',
      'import "@typespec/openapi";',
      'import "@superschema/typespec-enterprise";',
      "using TypeSpec.Http;",
      "",
      "model Pet { id: string; name: string; owner: Owner; }",
      "model Owner { email: string; }",
      "enum Species { Dog, Cat }",
    ].join("\n");
    const result = await compileTypeSpecWithGovernance(source);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.document.models.map((m) => m.name).sort()).toEqual(["Owner", "Pet"]);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("does not report a word `import` inside strings and comments as an import", async () => {
    const source = '/** import "/tmp/x.mjs"; */\nmodel A {\n  @doc("import \\"/tmp/y.mjs\\";") x: string;\n}\n';
    const result = await compileTypeSpecWithGovernance(source);
    expect(result.success).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
  });
});

describe("compileTypeSpecDocument (TypeSpec / OpenAPI importers)", () => {
  it.each(bypassForms("/placeholder"))("rejects %s with TypeSpecImportGuardError and never calls compile", async (_name, template) => {
    const source = template.replaceAll("/placeholder", script);
    await expect(compileTypeSpecDocument(source)).rejects.toBeInstanceOf(TypeSpecImportGuardError);
    expect(compile).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });

  it("still compiles a legitimate multi-model source with library imports", async () => {
    const doc = await compileTypeSpecDocument('import "@typespec/http";\nusing TypeSpec.Http;\nmodel Pet { id: string; }\nmodel Owner { email: string; }\n');
    expect(doc.models.map((m) => m.name).sort()).toEqual(["Owner", "Pet"]);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("does not throw for a source with syntax errors and only allowed imports (the compiler recovers, as before)", async () => {
    await expect(compileTypeSpecDocument('import "@typespec/http";\nmodel A { x: string; }\nmodel B {')).resolves.toBeDefined();
  });
});

describe("createLibraryOnlyHost (second layer: even a source that got past the guard cannot run host JavaScript)", () => {
  async function compileDirect(source: string) {
    const main = join(dir, "main.tsp");
    writeFileSync(main, source);
    return compile(createLibraryOnlyHost(), main, { noEmit: true });
  }

  it("does not execute a script imported by absolute path; the compiler reports a js-error diagnostic", async () => {
    const program = await compileDirect(`import "${script}";\nmodel A { x: string; }\n`);
    expect(existsSync(marker)).toBe(false);
    expect(program.diagnostics.map((d) => d.code)).toContain("js-error");
  });

  it("does not execute a script imported by relative path either", async () => {
    await compileDirect('import "./x.mjs";\nmodel A { x: string; }\n');
    expect(existsSync(marker)).toBe(false);
  });

  it("proves the test is meaningful: the plain NodeHost DOES execute the same script", async () => {
    const main = join(dir, "main.tsp");
    writeFileSync(main, `import "${script}";\nmodel A { x: string; }\n`);
    await compile(NodeHost, main, { noEmit: true });
    expect(existsSync(marker)).toBe(true);
  });

  it("does not follow a symlink that points out of the trusted roots", async () => {
    const link = join(dir, "sub");
    mkdirSync(link);
    symlinkSync(script, join(link, "y.mjs"));
    await compileDirect('import "./sub/y.mjs";\nmodel A { x: string; }\n');
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses JavaScript outside the trusted roots and remote reads at the host level", async () => {
    const host = createLibraryOnlyHost();
    await expect(host.getJsImport(script)).rejects.toThrow(/installed TypeSpec libraries/);
    await expect(host.getJsImport(join(dir, "missing.mjs"))).rejects.toThrow(/installed TypeSpec libraries/);
    await expect(host.readUrl("https://example.com/x.tsp")).rejects.toThrow(/Remote imports are disabled/);
  });

  describe("trusts only the compiler and the installed @typespec/* and @superschema/* packages", () => {
    const plant = (cwd: string, ...segments: string[]) => {
      const pkg = join(cwd, "node_modules", ...segments);
      mkdirSync(pkg, { recursive: true });
      return pkg;
    };

    it("does not load another package of node_modules (a planted package is not executed, even imported by name)", async () => {
      const cwd2 = join(dir, "cwd2");
      const evil = plant(cwd2, "evil");
      writeFileSync(join(evil, "package.json"), JSON.stringify({ name: "evil", version: "1.0.0", main: "x.mjs" }));
      writeFileSync(join(evil, "x.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nexport const $decorators = {};\n`);
      const main = join(cwd2, "main.tsp");
      writeFileSync(main, 'import "evil";\nmodel A { x: string; }\n');
      const program = await compile(createLibraryOnlyHost({ cwd: cwd2 }), main, { noEmit: true });
      expect(existsSync(marker)).toBe(false);
      expect(program.diagnostics.map((d) => d.code)).toContain("js-error");
      await expect(createLibraryOnlyHost({ cwd: cwd2 }).getJsImport(join(evil, "x.mjs"))).rejects.toThrow(/installed TypeSpec libraries/);
    });

    it("does not trust a node_modules directory higher up the tree either", async () => {
      const cwd2 = join(dir, "cwd2");
      mkdirSync(cwd2, { recursive: true });
      const hoisted = plant(dir, "hoisted"); // <dir>/node_modules/hoisted, above cwd2
      writeFileSync(join(hoisted, "index.mjs"), "export const x = 1;\n");
      await expect(createLibraryOnlyHost({ cwd: cwd2 }).getJsImport(join(hoisted, "index.mjs"))).rejects.toThrow(/installed TypeSpec libraries/);
    });

    it("loads JavaScript of a package installed under @typespec or @superschema, and of the compiler itself", async () => {
      const cwd2 = join(dir, "cwd2");
      writeFileSync(join(plant(cwd2, "@typespec", "legit"), "index.mjs"), "export const x = 1;\n");
      writeFileSync(join(plant(cwd2, "@superschema", "legit"), "index.mjs"), "export const y = 2;\n");
      const host = createLibraryOnlyHost({ cwd: cwd2 });
      await expect(host.getJsImport(join(cwd2, "node_modules", "@typespec", "legit", "index.mjs"))).resolves.toMatchObject({ x: 1 });
      await expect(host.getJsImport(join(cwd2, "node_modules", "@superschema", "legit", "index.mjs"))).resolves.toMatchObject({ y: 2 });
      const compilerEntry = join(host.getExecutionRoot(), "dist", "src", "index.js");
      await expect(host.getJsImport(compilerEntry)).resolves.toBeDefined();
    });

    it("still compiles with every library the app uses (installed, symlinked workspace packages included)", async () => {
      const work = join(process.cwd(), ".typespec-work");
      mkdirSync(work, { recursive: true });
      const jobDir = mkdtempSync(join(work, "f1-libs-"));
      try {
        for (const libs of [
          ["@typespec/http", "@typespec/rest", "@typespec/openapi", "@typespec/openapi3", "@typespec/versioning"],
          ["@typespec/json-schema", "@typespec/protobuf", "@superschema/typespec-enterprise"],
          ["@typespec/avro"],
          ["@typespec/java-pojo"],
        ]) {
          const main = join(jobDir, `main-${libs.length}-${libs[0].replace(/\W/g, "_")}.tsp`);
          writeFileSync(main, `${libs.map((l) => `import "${l}";`).join("\n")}\nmodel A { x: string; }\n`);
          const program = await compile(createLibraryOnlyHost(), main, { noEmit: true });
          const problems = program.diagnostics.filter((d) => d.code === "js-error" || d.code === "import-not-found" || d.code === "library-invalid");
          expect(problems.map((d) => `${d.code}: ${d.message}`), libs.join(",")).toEqual([]);
        }
      } finally {
        rmSync(jobDir, { recursive: true, force: true });
      }
    });
  });

  it("still loads installed libraries (including the symlinked governance package) and compiles with them", async () => {
    // Library resolution walks up to <project>/node_modules, so (like compileSource) compile inside the project tree.
    const work = join(process.cwd(), ".typespec-work");
    mkdirSync(work, { recursive: true });
    const jobDir = mkdtempSync(join(work, "f1-test-"));
    try {
      const main = join(jobDir, "main.tsp");
      writeFileSync(
        main,
        'import "@typespec/http";\nimport "@superschema/typespec-enterprise";\nusing TypeSpec.Http;\nmodel A { @Enterprise.dataClassification(Enterprise.DataClassification.PII) email: string; }\n'
      );
      const program = await compile(createLibraryOnlyHost(), main, { noEmit: true });
      expect(program.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(program.sourceFiles.size).toBeGreaterThan(1);
    } finally {
      rmSync(jobDir, { recursive: true, force: true });
    }
  });
});
