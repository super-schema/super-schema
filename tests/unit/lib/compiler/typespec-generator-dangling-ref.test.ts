import { describe, expect, it } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { buildDecoratorsFromParsedField } from "@/lib/importers/decorator-builder";

const entity = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
const field = (name: string, type: string, decorators: Record<string, unknown>, nullable = false): PrismaFieldInput => ({
  id: name, name, type, precision: null, scale: null, nullable, isKey: false, fieldNumber: null, description: "", classification: null,
  aliases: [], decorators, sortOrder: 0,
});
const source = (...fields: PrismaFieldInput[]) => generateTypeSpec(compileEntity(entity, fields), { governance: false });

describe("a field with a dangling external $ref", () => {
  it("is generated as unknown carrying the raw $ref, with only the decorators valid on unknown", () => {
    const text = source(
      field("created", "reference", {
        referencedEntityName: "date_time",
        danglingRef: { ref: "common/date_time.json", reason: "x" },
        typespec: { validation: { minLength: 1, pattern: "^a$" } },
        semantics: { description: "when" },
      }),
    );
    expect(text).toContain("created: unknown;");
    expect(text).toContain('@TypeSpec.JsonSchema.extension("$ref", "common/date_time.json")');
    expect(text).toContain('@TypeSpec.OpenAPI.extension("$ref", "common/date_time.json")');
    expect(text).not.toContain("date_time;");
    expect(text).not.toContain("@minLength");
    expect(text).not.toContain("@pattern");
    expect(text).toContain('import "@typespec/json-schema";');
  });

  it("an array of dangling items is unknown[] with its bounds and an items extension", () => {
    const text = source(
      field("links", "array", {
        arrayElementType: "reference",
        referencedEntityName: "user_links",
        danglingRef: { ref: "user_links.json", element: true, reason: "x" },
        typespec: { validation: { minItems: 1, maxItems: 100 } },
      }),
    );
    expect(text).toContain("links: unknown[];");
    expect(text).toContain("@minItems(1)");
    expect(text).toContain("@maxItems(100)");
    expect(text).toContain('@TypeSpec.JsonSchema.extension("items", #{`$ref`: "user_links.json"})');
  });

  it("a #/ pointer reference (a name that must already exist) keeps referencing it", () => {
    expect(source(field("owner", "reference", { referencedEntityName: "Customer" }))).toContain("owner: Customer;");
  });

  it("escapes the raw reference", () => {
    const text = source(field("x", "reference", { referencedEntityName: "a", danglingRef: { ref: 'we"ird.json', reason: "x" } }));
    expect(text).toContain('"we\\"ird.json"');
  });

  it("the importer's decorator builder persists the marker the compiler reads back", () => {
    const decorators = buildDecoratorsFromParsedField({
      name: "x", type: "reference", nullable: false, confidence: "low", originalType: "a.json", isKey: false,
      referencedEntityName: "a", danglingRef: { ref: "a.json", reason: "r" },
    } as never);
    expect(decorators.danglingRef).toEqual({ ref: "a.json", reason: "r" });
    expect(compileEntity(entity, [field("x", "reference", decorators)]).fields[0].danglingRef).toEqual({ ref: "a.json" });
  });
});
