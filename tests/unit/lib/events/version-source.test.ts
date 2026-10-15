import { describe, it, expect } from "vitest";
import { combineTypeSpecSources, findRootModelName, levelNamespace, splitTypeSpecStatements, stripGovernanceOverlay } from "@/lib/events/version-source";

describe("splitTypeSpecStatements", () => {
  it("keeps decorators + comments with their statement; braces / semicolons inside strings do not split", () => {
    const src = [
      'import "@typespec/json-schema";',
      "using TypeSpec.JsonSchema;",
      "namespace Old.Ns;",
      "",
      "/** Order */",
      '@doc("has { braces } and ; semicolons")',
      "model Order {",
      "  id: string;",
      '  @pattern("^[a-z]+$") code: string;',
      "}",
      "",
      "enum Status { Active, Retired }",
      "alias Id = string;",
      "model Wrapped is Array<{ a: string }>;",
    ].join("\n");
    const r = splitTypeSpecStatements(src);
    expect(r.success && r.data.map((s) => [s.kind, s.name ?? null])).toEqual([
      ["import", null], ["using", null], ["namespace", null],
      ["declaration", "Order"], ["declaration", "Status"], ["declaration", "Id"], ["declaration", "Wrapped"],
    ]);
    expect(r.success && r.data[3].text.startsWith("/** Order */")).toBe(true);
  });

  it("reports unbalanced braces and unterminated strings", () => {
    expect(splitTypeSpecStatements("model A {").success).toBe(false);
    expect(splitTypeSpecStatements('model A { @doc("x) a: string; }').success).toBe(false);
  });
});

describe("combineTypeSpecSources", () => {
  it("hoists imports, drops file-level namespaces and dedupes identical declarations (first copy wins)", () => {
    const r = combineTypeSpecSources([
      { label: "Order@1.0", source: 'import "@typespec/json-schema";\nnamespace A;\nenum Status { Active }\nmodel Order { id: string; status: Status; address: Address; }\n' },
      { label: "Address@1.0", source: "namespace B;\nenum Status { Active }\nmodel Address { street: string; }\n" },
    ]);
    expect(r.success && r.data.imports).toEqual(['import "@typespec/json-schema";']);
    expect(r.success && r.data.body).toBe(
      "enum Status { Active }\n\nmodel Order { id: string; status: Status; address: Address; }\n\nmodel Address { street: string; }"
    );
    expect(r.success && r.data.warnings).toEqual([]);
  });

  it("treats copies that differ only in whitespace and comments as identical", () => {
    const r = combineTypeSpecSources([
      { label: "A@1.0", source: "enum Status { Active, Retired }\n" },
      { label: "B@1.0", source: "// shared\n/** Status */\nenum   Status {\n  Active, // on\n  Retired,\n}\n".replace("Retired,\n", "Retired\n") },
    ]);
    expect(r.success && r.data.body).toBe("enum Status { Active, Retired }");
  });

  it("refuses an edited shared declaration between two pinned versions instead of picking a copy", () => {
    const r = combineTypeSpecSources([
      { label: "Order@1.0", source: "enum Status { Active }\nmodel Order { status: Status; }\n" },
      { label: "Customer@2.0", source: "enum Status { Active, Retired }\n" },
    ]);
    expect(!r.success && r.error.code).toBe("TYPESPEC_DECLARATION_CONFLICT");
    expect(!r.success && r.error.message).toContain('"Status"');
    expect(!r.success && r.error.message).toContain("Order@1.0");
    expect(!r.success && r.error.message).toContain("Customer@2.0");
    expect(!r.success && r.error.details).toEqual({
      name: "Status",
      first: { label: "Order@1.0", keyword: "enum" },
      second: { label: "Customer@2.0", keyword: "enum" },
    });
  });

  it("refuses the same name declared as a different kind (model X vs enum X)", () => {
    const r = combineTypeSpecSources([
      { label: "A@1.0", source: "model Shared { a: string; }\n" },
      { label: "B@1.0", source: "enum Shared { One }\n" },
    ]);
    expect(!r.success && r.error.code).toBe("TYPESPEC_DECLARATION_CONFLICT");
    expect(!r.success && r.error.message).toContain("as model in A@1.0 and as enum in B@1.0");
  });

  it("hoists only @typespec/* and the governance library; any other import specifier is TYPESPEC_IMPORT_NOT_ALLOWED", () => {
    const ok = combineTypeSpecSources([
      { label: "A@1.0", source: 'import "@typespec/http";\nimport "@superschema/typespec-enterprise";\nmodel A { a: string; }\n' },
    ]);
    expect(ok.success && ok.data.imports).toEqual(['import "@typespec/http";', 'import "@superschema/typespec-enterprise";']);
    for (const specifier of [
      "./other.tsp", "../other.tsp", "/etc/passwd", "C:/x.tsp", "lib.js", "other.tsp", "https://example.com/x.tsp",
      "@typespec/http/../../x", "@typespec/", "@evil/typespec-enterprise", "@superschema/typespec-enterprise/x", "@typespec/http.js",
    ]) {
      const r = combineTypeSpecSources([{ label: "Bad@1.0", source: `import "${specifier}";\nmodel Bad { a: string; }\n` }]);
      expect(!r.success && r.error.code, specifier).toBe("TYPESPEC_IMPORT_NOT_ALLOWED");
      expect(!r.success && r.error.details, specifier).toEqual({ label: "Bad@1.0", specifier });
    }
  });

  // Final review C-C1: the allowlist used to be bypassed by anything the hand-written scanner did not read as an
  // import. Imports are now found by TypeSpec's own parser, so every form below is seen and refused.
  describe("import allowlist cannot be bypassed (C-C1)", () => {
    const notAllowed = (source: string) => combineTypeSpecSources([{ label: "Evil@1.0", source }]);

    it.each([
      ["no space between `import` and the string", 'import"/tmp/x.mjs";\nmodel A { x: string; }\n', "/tmp/x.mjs"],
      ["an import after a closing brace on the same line", 'model A { x: string; } import "/tmp/x.mjs";\n', "/tmp/x.mjs"],
      ["an import after a closing brace, no space either", 'model A { x: string; }import"/tmp/x.mjs";\n', "/tmp/x.mjs"],
      ["a relative path", 'import "./evil.mjs";\nmodel A { x: string; }\n', "./evil.mjs"],
      ["a relative path, no space", 'import"../evil.mjs";\nmodel A { x: string; }\n', "../evil.mjs"],
      ["an absolute path", 'import "/etc/passwd";\nmodel A { x: string; }\n', "/etc/passwd"],
      ["a .tsp file", 'import "./x.tsp";\nmodel A { x: string; }\n', "./x.tsp"],
      ["an import after a block comment", '/* harmless */ import "/tmp/x.mjs";\nmodel A { x: string; }\n', "/tmp/x.mjs"],
      ["an import after a line comment's newline", '// note\nimport "/tmp/x.mjs";\nmodel A { x: string; }\n', "/tmp/x.mjs"],
      ["an import hidden after an allowed import on the same line", 'import "@typespec/http"; import"/tmp/x.mjs";\nmodel A { x: string; }\n', "/tmp/x.mjs"],
      ["several imports on one line", 'import "@typespec/http";import"@typespec/rest";import "./x.mjs";', "./x.mjs"],
      ["an import in a namespace block", 'namespace N { import "/tmp/x.mjs"; model A { x: string; } }\n', "/tmp/x.mjs"],
      ["a string that continues past a doc comment mention", '/** import "@typespec/http"; */\nmodel A { x: string; } import "/tmp/x.mjs";\n', "/tmp/x.mjs"],
      ["a leading byte-order mark", '\uFEFFimport"/tmp/x.mjs";\n', "/tmp/x.mjs"],
    ])("refuses %s", (_name, source, specifier) => {
      const r = notAllowed(source);
      expect(!r.success && r.error.code).toBe("TYPESPEC_IMPORT_NOT_ALLOWED");
      expect(!r.success && r.error.details).toEqual({ label: "Evil@1.0", specifier });
    });

    it("refuses an import in ANY part, naming the part", () => {
      const r = combineTypeSpecSources([
        { label: "Good@1.0", source: 'import "@typespec/http";\nmodel Good { a: string; }\n' },
        { label: "Evil@2.0", source: 'model Evil { a: string; } import"/tmp/x.mjs";\n' },
      ]);
      expect(!r.success && r.error.code).toBe("TYPESPEC_IMPORT_NOT_ALLOWED");
      expect(!r.success && r.error.message).toContain("Evil@2.0");
    });

    it("does not mistake the word `import` in strings, comments, doc comments or decorator arguments for an import", () => {
      const source = [
        'import "@typespec/http";',
        '/** import "/tmp/x.mjs"; */',
        '// import "/tmp/y.mjs";',
        '/* import"/tmp/z.mjs"; */',
        '@doc("import \\"/tmp/w.mjs\\";")',
        "model A {",
        '  @doc("""',
        '  import "/tmp/v.mjs";',
        '  """)',
        "  importer: string;",
        '  note: "import \\"x\\";";',
        "}",
        "",
      ].join("\n");
      const r = combineTypeSpecSources([{ label: "A@1.0", source }]);
      expect(r.success && r.data.imports).toEqual(['import "@typespec/http";']);
      expect(r.success && r.data.body).toContain("model A {");
    });

    it("hoists an allowed import written without a space, and one that trails a closing brace", () => {
      const r = combineTypeSpecSources([
        { label: "A@1.0", source: 'import"@typespec/json-schema";\nmodel A { x: string; }\n' },
        { label: "B@1.0", source: 'model B { y: string; } import "@typespec/http";\n' },
      ]);
      expect(r.success && r.data.imports).toEqual(['import "@typespec/json-schema";', 'import "@typespec/http";']);
      expect(r.success && r.data.body).toBe("model A { x: string; }\n\nmodel B { y: string; }");
    });

    it("de-duplicates the same library written differently and keeps a multi-model source intact", () => {
      const r = combineTypeSpecSources([
        {
          label: "Order@1.0",
          source: 'import "@typespec/http";\nimport  "@typespec/rest" ;\nusing TypeSpec.Http;\nenum Status { Active }\nmodel Order { id: string; status: Status; line: Line; }\nmodel Line { sku: string; }\n',
        },
        { label: "Customer@1.0", source: 'import"@typespec/http";\nmodel Customer { name: string; }\n' },
      ]);
      expect(r.success && r.data.imports).toEqual(['import "@typespec/http";', 'import "@typespec/rest";']);
      expect(r.success && r.data.usings).toEqual(["using TypeSpec.Http;"]);
      expect(r.success && r.data.body).toBe(
        "enum Status { Active }\n\nmodel Order { id: string; status: Status; line: Line; }\n\nmodel Line { sku: string; }\n\nmodel Customer { name: string; }"
      );
    });

    it("returns a clean error, never a throw, for a source the TypeSpec parser cannot make sense of", () => {
      for (const source of ['import "', "model A {", 'import"/tmp/x.mjs"', "import ;", "\u0000\u0000", "@@@@", '"""', "/*"]) {
        expect(() => combineTypeSpecSources([{ label: "Bad@1.0", source }]), source).not.toThrow();
      }
      const r = combineTypeSpecSources([{ label: "Bad@1.0", source: 'import"/tmp/x.mjs"' }]); // no `;`: the parser still reads the import
      expect(!r.success && r.error.code).toBe("TYPESPEC_IMPORT_NOT_ALLOWED");
    });
  });
});

describe("levelNamespace / findRootModelName", () => {
  it("PascalCases the level path (spec §4.4)", () => {
    expect(levelNamespace({ tenantSlug: "acme", domainSlug: "payments", productSlug: "checkout-v2" })).toBe("Acme.Payments.CheckoutV2");
    expect(levelNamespace({ tenantSlug: "acme", domainSlug: null, productSlug: null })).toBe("Acme");
    expect(levelNamespace({ tenantSlug: "1st", domainSlug: null, productSlug: null })).toBe("N1st");
  });

  it("finds the model named after the entity; a single model is the fallback", () => {
    expect(findRootModelName("enum S { A }\nmodel Line { a: string; }\nmodel Order { l: Line; }", "Order")).toEqual({ success: true, data: "Order" });
    expect(findRootModelName("model Line { a: string; }", "Order Line")).toEqual({ success: true, data: "Line" });
    expect(findRootModelName("enum S { A }", "Order")).toEqual({ success: true, data: null });
  });

  it("refuses to guess among several models when none is named after the entity", () => {
    const r = findRootModelName("model Line { a: string; }\nmodel Other { b: string; }", "Order");
    expect(!r.success && r.error.code).toBe("ROOT_MODEL_NOT_FOUND");
    expect(!r.success && r.error.details).toEqual({ entityName: "Order", models: ["Line", "Other"] });
    expect(findRootModelName("model A {", "Order").success).toBe(false);
  });
});

describe("stripGovernanceOverlay", () => {
  const overlay = [
    'import "@superschema/typespec-enterprise";',
    'import "@typespec/openapi";',
    "",
    '@TypeSpec.OpenAPI.extension("x-tags", #["sales", "core"])',
    "model Order {",
    "  id: string;",
    "  @Enterprise.dataClassification(Enterprise.DataClassification.PII)",
    "  email: string;",
    '  @TypeSpec.OpenAPI.extension("x-classification", "CUSTOM (x)")',
    '  @doc("keeps @Enterprise.dataClassification(x) inside strings")',
    "  note?: string;",
    "}",
    "",
  ].join("\n");

  it("removes the generator's overlay decorators and the library imports nothing else uses", () => {
    expect(stripGovernanceOverlay(overlay)).toBe(
      [
        "",
        "model Order {",
        "  id: string;",
        "  email: string;",
        '  @doc("keeps @Enterprise.dataClassification(x) inside strings")',
        "  note?: string;",
        "}",
        "",
      ].join("\n")
    );
  });

  it("keeps an import that other code still needs, and leaves overlay-free sources untouched", () => {
    const authored = [
      'import "@superschema/typespec-enterprise";',
      'import "@typespec/openapi";',
      "using TypeSpec.OpenAPI;",
      "model A {",
      "  @Enterprise.dataClassification(Enterprise.DataClassification.PII)",
      "  a: string;",
      '  @extension("x-other", "1")',
      "  b: string;",
      "  @Enterprise.avroOrder(Enterprise.AvroFieldOrder.ignore)",
      "  c: string;",
      "}",
    ].join("\n");
    const stripped = stripGovernanceOverlay(authored);
    expect(stripped).not.toContain("dataClassification");
    expect(stripped).toContain('import "@superschema/typespec-enterprise";');
    expect(stripped).toContain('import "@typespec/openapi";');
    expect(stripped).toContain("@Enterprise.avroOrder(");
    const plain = 'import "@typespec/openapi";\nmodel B { x: string; }\n';
    expect(stripGovernanceOverlay(plain)).toBe(plain);
  });

  it("removes only lines that are solely an overlay decorator: a decorator sharing its line with other content stays", () => {
    const mixed = [
      'import "@superschema/typespec-enterprise";',
      "model M {",
      '  @Enterprise.dataClassification(Enterprise.DataClassification.PII) @doc("Email")',
      "  email: string;",
      "  @Enterprise.dataClassification(Enterprise.DataClassification.PII) phone: string;",
      "  @Enterprise.dataClassification(Enterprise.DataClassification.PII)",
      "  ssn: string;",
      '  @Enterprise.dataClassification(Enterprise.DataClassification.PII) // trailing comment',
      "  dob: string;",
      "}",
    ].join("\n");
    const stripped = stripGovernanceOverlay(mixed);
    expect(stripped).toBe(
      [
        'import "@superschema/typespec-enterprise";',
        "model M {",
        '  @Enterprise.dataClassification(Enterprise.DataClassification.PII) @doc("Email")',
        "  email: string;",
        "  @Enterprise.dataClassification(Enterprise.DataClassification.PII) phone: string;",
        "  ssn: string;",
        '  @Enterprise.dataClassification(Enterprise.DataClassification.PII) // trailing comment',
        "  dob: string;",
        "}",
      ].join("\n")
    );
  });

  it("never edits text inside strings, block comments or triple-quoted strings, and balances parentheses with strings", () => {
    const source = [
      'import "@superschema/typespec-enterprise";',
      "/*",
      "@Enterprise.dataClassification(Enterprise.DataClassification.PII)",
      "*/",
      '@doc("""',
      "@Enterprise.dataClassification(Enterprise.DataClassification.PII)",
      '""")',
      "model M {",
      '  @Enterprise.dataClassification(Enterprise.DataClassification.PII) @doc("a)")',
      "  a: string;",
      '  @TypeSpec.OpenAPI.extension("x-tags", #["a)", "b"])',
      "  b: string;",
      "  @Enterprise.dataClassification(Enterprise.DataClassification.PII)",
      "  c: string;",
      "}",
    ].join("\n");
    const stripped = stripGovernanceOverlay(source);
    expect(stripped.split("\n")).toEqual([
      'import "@superschema/typespec-enterprise";',
      "/*",
      "@Enterprise.dataClassification(Enterprise.DataClassification.PII)",
      "*/",
      '@doc("""',
      "@Enterprise.dataClassification(Enterprise.DataClassification.PII)",
      '""")',
      "model M {",
      '  @Enterprise.dataClassification(Enterprise.DataClassification.PII) @doc("a)")',
      "  a: string;",
      "  b: string;",
      "  c: string;",
      "}",
    ]);
  });

  it("leaves other x- extensions and other Enterprise decorators alone", () => {
    const source = 'model M {\n  @TypeSpec.OpenAPI.extension("x-other", "1")\n  a: string;\n  @Enterprise.avroOrder(Enterprise.AvroFieldOrder.ignore)\n  b: string;\n}\n';
    expect(stripGovernanceOverlay(source)).toBe(source);
  });
});
