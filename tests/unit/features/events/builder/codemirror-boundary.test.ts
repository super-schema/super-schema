// Repository-level guard: CodeMirror lives behind one wrapper. Only JsonEditor.tsx and codemirror-setup.ts may import `@codemirror/*`
// or `@lezer/*`, and JsonEditor.tsx reaches the setup only through a dynamic import(), so it stays out of every page's first bundle.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../../..");
const SRC = path.join(ROOT, "src");
const CONTROLS = "src/features/events/builder/template/controls";
const ALLOWED = [`${CONTROLS}/JsonEditor.tsx`, `${CONTROLS}/codemirror-setup.ts`];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}
const relative = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

// every way a module can name a package: from "x", import "x", import("x"), require("x"), export ... from "x"
const PACKAGE = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](@codemirror\/[^"']+|@lezer\/[^"']+|codemirror)["']/g;

function codeMirrorImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return Array.from(text.matchAll(PACKAGE), (match) => match[1]);
}

describe("CodeMirror is confined to its wrapper", () => {
  const files = sourceFiles(SRC);

  it("looks at the real source tree", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(relative)).toEqual(expect.arrayContaining(ALLOWED));
  });

  it("is imported by JsonEditor.tsx's setup module and by nothing else", () => {
    const offenders = files.filter((file) => !ALLOWED.includes(relative(file)) && codeMirrorImports(file).length > 0).map(relative);
    expect(offenders).toEqual([]);
  });

  it("the setup module really is where CodeMirror comes in", () => {
    const setup = codeMirrorImports(path.join(ROOT, ALLOWED[1]));
    for (const name of ["@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/language", "@codemirror/lang-json", "@codemirror/lang-yaml", "@codemirror/lint", "@lezer/highlight"]) {
      expect(setup).toContain(name);
    }
  });

  it("the React wrapper takes no value import of CodeMirror, and loads its setup lazily, never with a static import", () => {
    const wrapper = readFileSync(path.join(ROOT, ALLOWED[0]), "utf8");
    expect(codeMirrorImports(path.join(ROOT, ALLOWED[0]))).toEqual([]);
    expect(wrapper).toMatch(/import\(\s*["']\.\/codemirror-setup["']\s*\)/);
    // only `import type` may name the setup statically (it is erased)
    const staticImports = Array.from(wrapper.matchAll(/^import\s+(?!type\b)[^;]*?from\s*["']\.\/codemirror-setup["']/gm));
    expect(staticImports).toEqual([]);
  });

  it("nothing else in src imports the setup module, so only JsonEditor can pull it in", () => {
    const importers = files
      .filter((file) => relative(file) !== ALLOWED[0] && /["'](?:\.\/|@\/features\/events\/builder\/template\/controls\/)codemirror-setup["']/.test(readFileSync(file, "utf8")))
      .map(relative);
    expect(importers).toEqual([]);
  });

  it("the CodeMirror packages are direct dependencies, not left to chance", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = { ...manifest.devDependencies, ...manifest.dependencies };
    for (const name of ["@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/language", "@codemirror/lang-json", "@codemirror/lang-yaml", "@codemirror/lint", "@lezer/highlight"]) {
      expect(declared[name], name).toBeTruthy();
    }
  });
});
