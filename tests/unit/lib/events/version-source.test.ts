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
  it("hoists imports, drops file-level namespaces, dedupes declarations and warns on divergent copies", () => {
    const r = combineTypeSpecSources([
      { label: "Order@1.0", source: 'import "@typespec/json-schema";\nnamespace A;\nenum Status { Active }\nmodel Order { id: string; status: Status; address: Address; }\n' },
      { label: "Address@1.0", source: "namespace B;\nenum Status { Active }\nmodel Address { street: string; }\n" },
      { label: "Customer@2.0", source: "enum Status { Active, Retired }\n" },
    ]);
    expect(r.success && r.data.imports).toEqual(['import "@typespec/json-schema";']);
    expect(r.success && r.data.body).toBe(
      "enum Status { Active }\n\nmodel Order { id: string; status: Status; address: Address; }\n\nmodel Address { street: string; }"
    );
    expect(r.success && r.data.warnings).toEqual(['"Status" from Customer@2.0 differs from the copy in Order@1.0; the Order@1.0 copy is used']);
  });
});

describe("levelNamespace / findRootModelName", () => {
  it("PascalCases the level path (spec §4.4)", () => {
    expect(levelNamespace({ tenantSlug: "acme", domainSlug: "payments", productSlug: "checkout-v2" })).toBe("Acme.Payments.CheckoutV2");
    expect(levelNamespace({ tenantSlug: "acme", domainSlug: null, productSlug: null })).toBe("Acme");
    expect(levelNamespace({ tenantSlug: "1st", domainSlug: null, productSlug: null })).toBe("N1st");
  });

  it("finds the model named after the entity, else the first model", () => {
    expect(findRootModelName("enum S { A }\nmodel Line { a: string; }\nmodel Order { l: Line; }", "Order")).toBe("Order");
    expect(findRootModelName("model Line { a: string; }", "Order Line")).toBe("Line");
    expect(findRootModelName("enum S { A }", "Order")).toBeNull();
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
});
