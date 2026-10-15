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
