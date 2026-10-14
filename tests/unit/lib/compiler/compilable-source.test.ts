import { describe, it, expect } from "vitest";
import { toCompilableTypeSpec } from "@/lib/compiler/compilable-source";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { compileTypeSpecWithGovernance } from "@/lib/compiler/typespec-compiler";

describe("toCompilableTypeSpec", () => {
  it("strips model-level @tag lines, including several in a row, and nothing else", () => {
    const src = [
      '@doc("Orders")',
      '@friendlyName("Order")',
      '@tag("sales")',
      '@tag("pii")',
      "model Order {",
      "  id: string;",
      "}",
      "",
    ].join("\n");
    expect(toCompilableTypeSpec(src)).toBe(
      ['@doc("Orders")', '@friendlyName("Order")', "model Order {", "  id: string;", "}", ""].join("\n")
    );
  });

  it('strips field-level @tag("classification:...") lines and keeps the field and its other decorators', () => {
    const src = [
      "model User {",
      '  @doc("Email")',
      '  @tag("classification:PII")',
      "  email?: string;",
      "}",
      "",
    ].join("\n");
    expect(toCompilableTypeSpec(src)).toBe(
      ["model User {", '  @doc("Email")', "  email?: string;", "}", ""].join("\n")
    );
  });

  it("handles tags that contain escaped quotes or backslashes (the generator's escapeString output)", () => {
    const src = ['@tag("say \\"hi\\"")', '@tag("back\\\\slash")', "model A {}", ""].join("\n");
    expect(toCompilableTypeSpec(src)).toBe("model A {}\n");
  });

  it("strips a @tag on the last line without a trailing newline", () => {
    expect(toCompilableTypeSpec('model A {}\n@tag("x")')).toBe("model A {}\n");
  });

  it("is a no-op on a source without @tag lines (same string back)", () => {
    const clean = '@doc("x")\nmodel A {\n  id: string;\n}\n';
    expect(toCompilableTypeSpec(clean)).toBe(clean);
  });

  it("never touches @tag text inside a string, or other decorators that merely start with tag", () => {
    const src = [
      '@doc("see @tag(\\"sales\\") for details")',
      '@service(#{ title: "tag" })',
      '@tagline("x")',
      '@tags("x")',
      "model A {}",
      "",
    ].join("\n");
    expect(toCompilableTypeSpec(src)).toBe(src);
  });

  it("only strips a @tag that is the whole line (not one with other content after it)", () => {
    const src = '@tag("x") model A {}\n';
    expect(toCompilableTypeSpec(src)).toBe(src);
  });
});

describe("toCompilableTypeSpec on real generator output", () => {
  const fld = (name: string, extra: Partial<{ classification: string | null }> = {}, i = 0) => ({
    id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
    fieldNumber: null, description: "", classification: extra.classification ?? null, aliases: [] as string[],
    decorators: {}, sortOrder: i,
  });
  const generate = (metadata: unknown, fields: ReturnType<typeof fld>[]) =>
    generateTypeSpec(
      compileEntity(
        { id: "e1", name: "Order", description: "Orders", status: "DRAFT", version: 1, domainId: null, metadata, domain: null },
        fields
      )
    );

  it("real TypeSpec rejects the generator's own @tag output, and accepts it once stripped", async () => {
    const source = generate({ tags: ["sales"] }, [fld("id"), fld("email", { classification: "PII" }, 1)]);
    expect(source).toContain('@tag("sales")');
    expect(source).toContain('@tag("classification:PII")');

    const raw = await compileTypeSpecWithGovernance(source);
    expect(raw.success).toBe(false);
    expect(raw.diagnostics.some((d) => d.message.includes("@tag"))).toBe(true);

    const stripped = toCompilableTypeSpec(source);
    expect(stripped).not.toContain("@tag(");
    expect(stripped).toContain('@doc("Orders")');
    const compiled = await compileTypeSpecWithGovernance(stripped);
    expect(compiled.success).toBe(true);
  }, 60_000);
});
