import { describe, expect, it } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";

// Found by the corpus round trip (js-enum-weird-values): an imported enum's symbols travelled to the generator joined with `|` in the
// pattern slot and were split on `|` again, so `""` (a legal JSON Schema symbol) vanished and `"a|b"` became two symbols `a` and `b`.
// Symbols now also travel verbatim as the field's aliases, which the generator prefers.
const entity = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };

function generated(symbols: string[]): string {
  const parsed = parseJsonSchemaDocument(JSON.stringify({ title: "Evt", type: "object", properties: { s: { type: "string", enum: symbols } } }));
  if (!parsed.success) throw new Error(parsed.error.message);
  const input = parsedFieldToCreateFieldInput(parsed.data.entities[0].fields[0]);
  const field = { id: "f", name: input.name, type: input.type, precision: null, scale: null, nullable: input.nullable, isKey: false, fieldNumber: null, description: "", classification: null, aliases: input.aliases ?? [], decorators: input.decorators ?? {}, sortOrder: 0 } as PrismaFieldInput;
  return generateTypeSpec(compileEntity(entity, [field]), { governance: false });
}

describe("an imported enum's symbols reach the generated source verbatim", () => {
  it("keeps an empty symbol and a symbol containing `|`", () => {
    const text = generated(["a|b", "", "plain"]);
    expect(text).toContain('"a|b"');
    expect(text).toContain('""');
    expect(text).toContain("plain");
    expect(text).not.toMatch(/^\s+a,$/m);
  });

  it("is unchanged for ordinary symbols", () => {
    const text = generated(["NEW", "OPEN"]);
    expect(text).toMatch(/enum Evt_s \{\s+NEW,\s+OPEN,\s+\}/);
  });
});
