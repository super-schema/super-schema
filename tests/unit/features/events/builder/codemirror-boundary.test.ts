// Repository-level guard: CodeMirror lives behind one wrapper. Only JsonEditor.tsx and codemirror-setup.ts may import `@codemirror/*`,
// `@lezer/*`, `codemirror` or `codemirror-json-schema`, and JsonEditor.tsx reaches the setup only through a dynamic import(), so it
// stays out of every page's first bundle. The setup in turn reaches the schema library (and its highlighter, which starts working the
// moment it is imported) and the completion UI only through import() too, so a page whose editors have no schema never loads them.
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

// every way a module can name a package: from "x", import "x", import("x"), require("x"), export ... from "x"; a subpath of the two plain
// packages counts too (`codemirror-json-schema/yaml`)
const PACKAGE = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](@codemirror\/[^"']+|@lezer\/[^"']+|codemirror(?:-json-schema)?(?:\/[^"']*)?)["']/g;

/** A module specifier that ends in `codemirror-setup`, from any folder: "./codemirror-setup", "../controls/codemirror-setup", "@/features/…/codemirror-setup". */
const SETUP_SPECIFIER = /["'](?:[^"']*\/)?codemirror-setup["']/;

/** The packages `text` names, in the order it names them. */
const packagesIn = (text: string): string[] => Array.from(text.matchAll(PACKAGE), (match) => match[1]);
const codeMirrorImports = (file: string): string[] => packagesIn(readFileSync(file, "utf8"));

/** A value `import ... from "name"` (not `import type`, which is erased). */
const staticImport = (text: string, name: string) =>
  new RegExp(`^import\\s+(?!type\\b)[^;]*?from\\s*["']${name}["']|^import\\s*["']${name}["']|\\brequire\\s*\\(\\s*["']${name}["']`, "m").test(text);

describe("CodeMirror is confined to its wrapper", () => {
  const files = sourceFiles(SRC);

  it("looks at the real source tree", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(relative)).toEqual(expect.arrayContaining(ALLOWED));
  });

  it("recognises every way of naming the packages, `codemirror-json-schema` included", () => {
    expect(packagesIn('import { a } from "codemirror-json-schema";')).toEqual(["codemirror-json-schema"]);
    expect(packagesIn('const lib = await import("codemirror-json-schema");')).toEqual(["codemirror-json-schema"]);
    expect(packagesIn("type L = typeof import('codemirror-json-schema');")).toEqual(["codemirror-json-schema"]);
    expect(packagesIn('const lib = require("codemirror-json-schema");')).toEqual(["codemirror-json-schema"]);
    expect(packagesIn('export * from "codemirror-json-schema";')).toEqual(["codemirror-json-schema"]);
    expect(packagesIn('import "codemirror-json-schema";')).toEqual(["codemirror-json-schema"]);
    expect(packagesIn('import { EditorView } from "codemirror";')).toEqual(["codemirror"]);
    expect(packagesIn('import type { SyntaxNode } from "@lezer/common";')).toEqual(["@lezer/common"]);
    expect(packagesIn('import { autocompletion } from "@codemirror/autocomplete";')).toEqual(["@codemirror/autocomplete"]);
    // a subpath of the package is the package
    expect(packagesIn('import { yamlSchema } from "codemirror-json-schema/yaml";')).toEqual(["codemirror-json-schema/yaml"]);
    expect(packagesIn('const lib = await import("codemirror-json-schema/json5");')).toEqual(["codemirror-json-schema/json5"]);
    expect(packagesIn("import { x } from 'codemirror/dist/index.js';")).toEqual(["codemirror/dist/index.js"]);
    expect(packagesIn('import { x } from "codemirror-json5";')).toEqual([]);
    expect(packagesIn('import { x } from "codemirror-json5/sub";')).toEqual([]);
    expect(packagesIn('import { x } from "./codemirror-json-schema-helpers";')).toEqual([]);
    expect(packagesIn('import { x } from "codemirror-json-schema-helpers/sub";')).toEqual([]);
  });

  it("is imported by JsonEditor.tsx's setup module and by nothing else", () => {
    const offenders = files.filter((file) => !ALLOWED.includes(relative(file)) && codeMirrorImports(file).length > 0).map(relative);
    expect(offenders).toEqual([]);
  });

  it("the setup module really is where CodeMirror and the schema library come in", () => {
    const setup = codeMirrorImports(path.join(ROOT, ALLOWED[1]));
    for (const name of [
      "@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/language", "@codemirror/lang-json", "@codemirror/lang-yaml",
      "@codemirror/lint", "@codemirror/autocomplete", "@lezer/common", "@lezer/highlight", "codemirror-json-schema",
    ]) {
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

  it("the setup module loads the schema library and the completion UI with import() only, so they are never in the editor's own chunk", () => {
    const setup = readFileSync(path.join(ROOT, ALLOWED[1]), "utf8");
    for (const name of ["codemirror-json-schema", "@codemirror/autocomplete"]) {
      expect(staticImport(setup, name), `${name} is imported statically`).toBe(false);
      // a run-time import(), not the `typeof import("x")` of a type
      expect(setup, `${name} is not loaded with import()`).toMatch(new RegExp(`(?<!typeof\\s+)\\bimport\\(\\s*["']${name}["']\\s*\\)`));
    }
  });

  it("the static-import matcher catches the forms it is there to catch", () => {
    for (const bad of [
      'import { a } from "codemirror-json-schema";',
      'import * as lib from "codemirror-json-schema";',
      'import lib, { a } from "codemirror-json-schema";',
      'import {\n  a,\n  b,\n} from "codemirror-json-schema";',
      'import "codemirror-json-schema";',
      'const lib = require("codemirror-json-schema");',
    ]) {
      expect(staticImport(bad, "codemirror-json-schema"), bad).toBe(true);
    }
    for (const fine of [
      'import type { A } from "codemirror-json-schema";',
      'const lib = await import("codemirror-json-schema");',
      "type L = typeof import('codemirror-json-schema');",
    ]) {
      expect(staticImport(fine, "codemirror-json-schema"), fine).toBe(false);
    }
  });

  it("nothing else in src imports the setup module, so only JsonEditor can pull it in", () => {
    const importers = files
      .filter((file) => relative(file) !== ALLOWED[0] && SETUP_SPECIFIER.test(readFileSync(file, "utf8")))
      .map(relative);
    expect(importers).toEqual([]);
  });

  it("the setup-module matcher catches it from any folder, by any path, and nothing that only looks like it", () => {
    for (const bad of [
      'import("./codemirror-setup")',
      "import('./codemirror-setup')",
      'import { x } from "./controls/codemirror-setup";',
      'import { x } from "../controls/codemirror-setup";',
      'import { x } from "../../template/controls/codemirror-setup";',
      'import { x } from "@/features/events/builder/template/controls/codemirror-setup";',
      'import { x } from "codemirror-setup";',
    ]) {
      expect(SETUP_SPECIFIER.test(bad), bad).toBe(true);
    }
    for (const fine of [
      'import { x } from "./codemirror-setup-helpers";',
      'import { x } from "./my-codemirror-setup";',
      'import { x } from "./codemirror-setup.test-utils";',
      'import { x } from "./controls/codemirror-jsdom";',
    ]) {
      expect(SETUP_SPECIFIER.test(fine), fine).toBe(false);
    }
  });

  it("the CodeMirror packages are direct dependencies, not left to chance", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = { ...manifest.devDependencies, ...manifest.dependencies };
    for (const name of [
      "@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/language", "@codemirror/lang-json", "@codemirror/lang-yaml",
      "@codemirror/lint", "@codemirror/autocomplete", "@lezer/common", "@lezer/highlight", "codemirror-json-schema",
    ]) {
      expect(declared[name], name).toBeTruthy();
    }
  });
});
