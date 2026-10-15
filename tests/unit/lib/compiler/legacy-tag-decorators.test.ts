/**
 * Story 16.6 — sources stored before the generator stopped emitting `@tag` (a publish wrote the generator's
 * text back into `entity.typespecSource`) are rewritten losslessly into the valid decorators when loaded
 * into the TypeSpec Source tab, so they can be saved again.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { upgradeLegacyTagDecorators } from "@/lib/compiler/legacy-tag-decorators";

vi.mock("server-only", () => ({}));

let compiler: typeof import("@/lib/compiler/typespec-compiler");
beforeAll(async () => {
  compiler = await import("@/lib/compiler/typespec-compiler");
});

const LEGACY = [
  "namespace Sales;",
  "",
  '@doc("Orders")',
  '@tag("sales")',
  '@friendlyName("Order")',
  '@tag("say \\"hi\\"")',
  "model Order {",
  "  @key",
  "  id: string;",
  '  @doc("Email")',
  '  @tag("classification:PII")',
  "  email?: string;",
  '  @tag("classification:TOP_SECRET")',
  "  code?: string;",
  "}",
  "",
].join("\n");

describe("upgradeLegacyTagDecorators", () => {
  it("rewrites model tags into one x-tags extension and field classifications into the governance decorators", () => {
    expect(upgradeLegacyTagDecorators(LEGACY)).toBe(
      [
        'import "@superschema/typespec-enterprise";',
        'import "@typespec/openapi";',
        "",
        "namespace Sales;",
        "",
        '@doc("Orders")',
        '@TypeSpec.OpenAPI.extension("x-tags", #["sales", "say \\"hi\\""])',
        '@friendlyName("Order")',
        "model Order {",
        "  @key",
        "  id: string;",
        '  @doc("Email")',
        "  @Enterprise.dataClassification(Enterprise.DataClassification.PII)",
        "  email?: string;",
        '  @TypeSpec.OpenAPI.extension("x-classification", "TOP_SECRET")',
        "  code?: string;",
        "}",
        "",
      ].join("\n")
    );
  });

  it("the upgraded legacy source compiles with zero errors", async () => {
    const result = await compiler.compileTypeSpecWithGovernance(upgradeLegacyTagDecorators(LEGACY));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.success).toBe(true);
  }, 60_000);

  it("is a no-op (same string) on a source without legacy tags, and idempotent", () => {
    const clean = '@doc("x")\nmodel A {\n  id: string;\n}\n';
    expect(upgradeLegacyTagDecorators(clean)).toBe(clean);
    const once = upgradeLegacyTagDecorators(LEGACY);
    expect(upgradeLegacyTagDecorators(once)).toBe(once);
  });

  it("leaves valid @tag targets (operation, interface, namespace) and @tag text inside strings alone", () => {
    const src = [
      '@tag("ns")',
      "namespace Shop;",
      '@tag("iface")',
      "interface Orders {",
      '  @tag("op")',
      "  op list(): void;",
      "}",
      '@doc("see @tag(\\"sales\\")")',
      "model A {}",
      "",
    ].join("\n");
    expect(upgradeLegacyTagDecorators(src)).toBe(src);
  });

  it("adds only the missing import and keeps an existing one", () => {
    const src = ['import "@typespec/openapi";', "", '@tag("sales")', "model A {}", ""].join("\n");
    expect(upgradeLegacyTagDecorators(src)).toBe(
      ['import "@typespec/openapi";', "", '@TypeSpec.OpenAPI.extension("x-tags", #["sales"])', "model A {}", ""].join("\n")
    );
  });
  describe("a source that uses the name `Enterprise` itself (R53)", () => {
    const legacyWith = (head: string[]) =>
      [...head, '@tag("sales")', "model Order {", '  @tag("classification:PII")', "  email?: string;", "}", ""].join("\n");

    it.each([
      ["a model named Enterprise", ["model Enterprise {}", ""]],
      ["a namespace segment named Enterprise", ["namespace Acme.Enterprise;", ""]],
      ["a bare reference stubbed by the publish gate", ["model Holder {", "  owner: Enterprise;", "}", ""]],
    ])("rewrites classification to x-classification and skips the enterprise import: %s", (_label, head) => {
      const out = upgradeLegacyTagDecorators(legacyWith(head));
      expect(out).toContain('@TypeSpec.OpenAPI.extension("x-classification", "PII")');
      expect(out).not.toContain("typespec-enterprise");
      expect(out).not.toContain("@Enterprise.");
      expect(out).toContain('import "@typespec/openapi";');
    });

    it("does not treat a string, a comment or a qualified library use as the name", () => {
      const out = upgradeLegacyTagDecorators(
        legacyWith(['@doc("Our Enterprise tier")', "// Enterprise customers", "model Plan {}", ""])
      );
      expect(out).toContain("@Enterprise.dataClassification(Enterprise.DataClassification.PII)");
      expect(out).toContain('import "@superschema/typespec-enterprise";');
    });

    it("the rewritten source compiles for real with an Enterprise model", async () => {
      const out = upgradeLegacyTagDecorators(legacyWith(["model Enterprise {}", ""]));
      const result = await compiler.compileTypeSpecWithGovernance(out);
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    }, 60_000);
  });
});
