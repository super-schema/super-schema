import { describe, it, expect, vi } from "vitest";

// `parse` stays real except where a test makes it throw (the guard must never propagate a parser failure).
vi.mock("@typespec/compiler/ast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@typespec/compiler/ast")>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

import { parse } from "@typespec/compiler/ast";
import {
  assertTypeSpecImportsAllowed,
  checkTypeSpecImports,
  isAllowedTypeSpecImport,
  scanTypeSpecImports,
  TypeSpecImportGuardError,
} from "@/lib/typespec/import-guard";

const specifiers = (source: string) => {
  const r = scanTypeSpecImports(source);
  if (!r.success) throw new Error(r.error.message);
  return r.data.imports.map((i) => i.specifier);
};

describe("isAllowedTypeSpecImport", () => {
  it("allows @typespec/<package> and the governance library, nothing else", () => {
    for (const ok of ["@typespec/http", "@typespec/openapi3", "@typespec/json-schema", "@typespec/db", "@superschema/typespec-enterprise"]) {
      expect(isAllowedTypeSpecImport(ok), ok).toBe(true);
    }
    for (const bad of [
      "./other.tsp", "../other.tsp", "/etc/passwd", "C:/x.tsp", "lib.js", "x.mjs", "other.tsp", "dir", "./dir", "https://example.com/x.tsp", "file:///tmp/x.mjs",
      "@typespec/http/../../x", "@typespec/http/lib/main.tsp", "@typespec/", "@typespec", "@evil/typespec-enterprise", "@superschema/typespec-enterprise/x",
      "@typespec/http.js", "typespec/http", "", " @typespec/http", "@typespec/http ", "@typespec/http\n",
    ]) {
      expect(isAllowedTypeSpecImport(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("scanTypeSpecImports (TypeSpec's own parser decides what is an import)", () => {
  it("finds an import written without a space", () => {
    expect(specifiers('import"/tmp/x.mjs";')).toEqual(["/tmp/x.mjs"]);
  });

  it("finds an import that follows a closing brace on the same line", () => {
    expect(specifiers('model A { x: string; } import "/tmp/x.mjs";')).toEqual(["/tmp/x.mjs"]);
    expect(specifiers('model A { x: string; }import"/tmp/x.mjs";')).toEqual(["/tmp/x.mjs"]);
  });

  it("finds imports after comments and several imports on one line, in source order", () => {
    expect(specifiers('/* c */ import "./a.tsp"; // t\n/** d */ import"./b.tsp";import "@typespec/http";')).toEqual(["./a.tsp", "./b.tsp", "@typespec/http"]);
  });

  it("reports the value the compiler will load (escape sequences resolved by the parser, not by us)", () => {
    // TypeSpec has no \u escapes: the parser reports an error and the value is what it would try to load.
    const [value] = specifiers('import "\\u002Ftmp/x.mjs";');
    expect(isAllowedTypeSpecImport(value)).toBe(false);
    expect(specifiers('import "\\"@typespec/http\\"";')).not.toEqual(["@typespec/http"]);
    expect(specifiers('import """@typespec/http""";').every(isAllowedTypeSpecImport)).toBe(true);
  });

  it("finds imports at every depth and marks which are top level", () => {
    const r = scanTypeSpecImports('import "@typespec/http";\nnamespace N { import "/tmp/x.mjs"; model A {} }\n');
    expect(r.success && r.data.imports.map((i) => [i.specifier, i.topLevel])).toEqual([
      ["@typespec/http", true],
      ["/tmp/x.mjs", false],
    ]);
  });

  it("gives offsets that cover exactly the statement", () => {
    const r = scanTypeSpecImports('// lead\nimport"/tmp/x.mjs";\nmodel A {}\n');
    expect(r.success && r.data.imports.map((i) => r.data.text.slice(i.pos, i.end))).toEqual(['import"/tmp/x.mjs";']);
  });

  it("does NOT treat the word `import` in strings, comments, doc comments or decorator arguments as an import", () => {
    const source = [
      '/** import "/a.mjs"; */',
      '// import "/b.mjs";',
      '/* import"/c.mjs"; */',
      '@doc("import \\"/d.mjs\\";")',
      "model A {",
      '  @doc("""',
      '  import "/e.mjs";',
      '  """)',
      "  importer: string;",
      "  `import`: string;",
      '  note: "import \\"/f.mjs\\";";',
      '  @format("import") x: string;',
      "}",
      "enum E { import_a, importB }",
      'alias S = "import \\"/g.mjs\\";";',
    ].join("\n");
    expect(specifiers(source)).toEqual([]);
  });

  it("parses what the compiler will read back from disk: a byte-order mark or a lone surrogate cannot hide an import", () => {
    expect(specifiers('\uFEFFimport"/tmp/x.mjs";')).toEqual(["/tmp/x.mjs"]);
    expect(specifiers('model A { @doc("\uD800") x: string; } import "/tmp/x.mjs";')).toEqual(["/tmp/x.mjs"]);
    expect(specifiers('\uFEFF\uFEFFimport"/tmp/x.mjs";').length).toBe(1);
  });

  it("is complete even when the source has syntax errors (the parser recovers; the compiler loads from the same tree)", () => {
    const r = scanTypeSpecImports('model A {\nimport "/tmp/x.mjs"\nmodel B { x: ');
    expect(r.success && r.data.parseErrors).toBeGreaterThan(0);
    expect(r.success && r.data.imports.map((i) => i.specifier)).toEqual(["/tmp/x.mjs"]);
  });

  it("never throws: a parser failure is a TYPESPEC_PARSE_ERROR result", () => {
    vi.mocked(parse).mockImplementationOnce(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    const r = scanTypeSpecImports('import "@typespec/http";');
    expect(r).toEqual({ success: false, error: { code: "TYPESPEC_PARSE_ERROR", message: "The TypeSpec source could not be parsed" } });
    expect(() => scanTypeSpecImports("[".repeat(300_000))).not.toThrow();
    expect(() => scanTypeSpecImports("model A {".repeat(100_000))).not.toThrow();
  });
});

describe("checkTypeSpecImports", () => {
  it("accepts allowed library imports and a source with none", () => {
    expect(checkTypeSpecImports('import "@typespec/http";\nimport "@typespec/rest";\nimport"@superschema/typespec-enterprise";\nmodel A { x: string; }').success).toBe(true);
    expect(checkTypeSpecImports("model A { x: string; }").success).toBe(true);
    expect(checkTypeSpecImports("").success).toBe(true);
  });

  it.each([
    ["no space", 'import"/tmp/x.mjs";', "/tmp/x.mjs"],
    ["after a brace", 'model A { x: string; } import "/tmp/x.mjs";', "/tmp/x.mjs"],
    ["relative path", 'import "./x.mjs";', "./x.mjs"],
    ["relative, no space", 'import"../x.mjs";', "../x.mjs"],
    ["absolute path", 'import "/etc/passwd";', "/etc/passwd"],
    ["tsp file", 'import "./x.tsp";', "./x.tsp"],
    ["directory", 'import "./lib";', "./lib"],
    ["url", 'import "https://example.com/x.tsp";', "https://example.com/x.tsp"],
    ["after a block comment", '/* c */ import "/tmp/x.mjs";', "/tmp/x.mjs"],
    ["subpath of an allowed library", 'import "@typespec/http/../../../tmp/x.mjs";', "@typespec/http/../../../tmp/x.mjs"],
    ["nested in a namespace", 'namespace N { import "/tmp/x.mjs"; }', "/tmp/x.mjs"],
  ])("rejects %s with TYPESPEC_IMPORT_NOT_ALLOWED", (_name, source, specifier) => {
    const r = checkTypeSpecImports(source);
    expect(r).toMatchObject({ success: false, error: { code: "TYPESPEC_IMPORT_NOT_ALLOWED", details: { specifier } } });
  });

  it("rejects the first offender even among allowed imports and after syntax errors", () => {
    const r = checkTypeSpecImports('import "@typespec/http";\nmodel A {\nimport"/tmp/x.mjs";');
    expect(r).toMatchObject({ success: false, error: { code: "TYPESPEC_IMPORT_NOT_ALLOWED", details: { specifier: "/tmp/x.mjs" } } });
  });

  it("carries the label in the message and details; prints a hostile specifier escaped and bounded", () => {
    const r = checkTypeSpecImports('import "a\\nb";', { label: "Order@1.0" });
    expect(!r.success && r.error.message).toMatch(/^Order@1\.0: import "/);
    expect(!r.success && r.error.message).not.toMatch(/[\n\r]/);
    expect(!r.success && r.error.details).toMatchObject({ label: "Order@1.0" });
    const long = checkTypeSpecImports(`import "${"a".repeat(5000)}";`);
    expect(!long.success && long.error.message.length).toBeLessThan(400);
  });

  it("tolerates syntax errors by default and rejects them on request (never throws either way)", () => {
    const source = "model A { x: ";
    expect(checkTypeSpecImports(source).success).toBe(true);
    expect(checkTypeSpecImports(source, { rejectParseErrors: true })).toMatchObject({ success: false, error: { code: "TYPESPEC_PARSE_ERROR" } });
    expect(checkTypeSpecImports(source, { rejectParseErrors: true, label: "A@1.0" })).toMatchObject({ error: { message: expect.stringContaining("A@1.0") } });
  });

  it("turns a parser failure into TYPESPEC_PARSE_ERROR (and keeps the label)", () => {
    vi.mocked(parse).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(checkTypeSpecImports("model A {}", { label: "A@1.0" })).toEqual({
      success: false,
      error: { code: "TYPESPEC_PARSE_ERROR", message: "A@1.0: The TypeSpec source could not be parsed" },
    });
  });
});

describe("assertTypeSpecImportsAllowed", () => {
  it("returns the scan for an acceptable source", () => {
    expect(assertTypeSpecImportsAllowed('import "@typespec/http";\nmodel A {}').imports.map((i) => i.specifier)).toEqual(["@typespec/http"]);
  });

  it("throws TypeSpecImportGuardError with the guard's code and details", () => {
    let thrown: unknown;
    try {
      assertTypeSpecImportsAllowed('import"/tmp/x.mjs";');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TypeSpecImportGuardError);
    expect(thrown).toMatchObject({ code: "TYPESPEC_IMPORT_NOT_ALLOWED", details: { specifier: "/tmp/x.mjs" } });
  });
});
