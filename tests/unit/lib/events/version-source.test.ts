import { describe, it, expect } from "vitest";
import { combineTypeSpecSources, findRootModelName, levelNamespace, splitTypeSpecStatements } from "@/lib/events/version-source";

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
