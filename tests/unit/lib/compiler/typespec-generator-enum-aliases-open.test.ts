import { describe, expect, it } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { mergeSyncedField } from "@/lib/typespec-sync/merge-fields";

// OPEN (design question, reported to the controller): an imported enum field now carries its symbols as `aliases` (commit 8b63d454) AND in
// `validation.pattern` ("A|B"). extractEnumValues prefers aliases, and the TypeSpec sync (merge-fields.ts) only ever touches `decorators`:
// it keeps an enum's pattern as "the truth" and never writes aliases. So a later change of the symbols through the pattern slot (or
// the sync) is overridden by the stale aliases. Before 8b63d454 the pattern was the only carrier, so this is new for imported enums.
const entity = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
const enumField = (aliases: string[], pattern: string): PrismaFieldInput => ({
  id: "f", name: "s", type: "enum", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", classification: null,
  aliases, decorators: { typespec: { validation: { pattern } } }, sortOrder: 0,
});
const source = (f: PrismaFieldInput) => generateTypeSpec(compileEntity(entity, [f]), { governance: false });

describe("an enum field that carries both aliases and a pattern", () => {
  it("generates the aliases (what the import writes)", () => {
    expect(source(enumField(["A", "B"], "A|B"))).toMatch(/enum Evt_s \{\s+A,\s+B,\s+\}/);
  });

  it("the sync keeps the stored pattern and never touches aliases (documented behavior of merge-fields.ts)", () => {
    const merged = mergeSyncedField({ type: "enum", nullable: false, isKey: false, description: "", classification: null, decorators: { typespec: { validation: { pattern: "A|B" } } } },
      { name: "s", type: "enum", isOptional: false, isKey: false, decorators: {} });
    expect((merged.decorators.typespec as { validation: { pattern: string } }).validation.pattern).toBe("A|B");
    expect(merged).not.toHaveProperty("aliases");
  });

  // OPEN: documents the hazard; flips to a normal test when the controller decides who owns the symbols.
  it.fails("a later edit of the symbols in the pattern slot reaches the generated source", () => {
    expect(source(enumField(["A", "B"], "A|C"))).toMatch(/\bC,/);
  });
});
