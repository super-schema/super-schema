/**
 * Bug-hunt #1: a validator the field's emitted TypeSpec scalar does not accept (`@maxLength` on utcDateTime, ...) fails the real
 * compiler with decorator-wrong-target. The generator withholds it (it stays in the stored decorators) and the import says so.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpecWithDiagnostics } from "@/lib/compiler/typespec-generator";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";
import type { ParsedEntity } from "@/lib/importers/types";

vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;
beforeAll(async () => {
  ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
});

function generateFor(entity: ParsedEntity) {
  const rows: PrismaFieldInput[] = entity.fields.map((f, i) => {
    const input = parsedFieldToCreateFieldInput(f);
    return {
      id: `f${i}`, name: input.name, type: input.type, precision: null, scale: null, nullable: input.nullable,
      isKey: input.isKey, fieldNumber: null, description: input.description ?? "", classification: null,
      aliases: input.aliases ?? [], decorators: (input.decorators ?? {}) as Record<string, unknown>, sortOrder: i,
    };
  });
  const e: PrismaEntityInput = {
    id: "e1", name: entity.name, description: "", status: "DRAFT", version: 1, domainId: "d1", metadata: {},
    domain: { id: "d1", name: "Sales", slug: "sales" },
  };
  return { ...generateTypeSpecWithDiagnostics(compileEntity(e, rows), { governance: false }), rows };
}

const SCHEMA = {
  title: "R",
  type: "object",
  properties: {
    ts: { type: "string", format: "date-time", maxLength: 30, pattern: "^2" },
    d: { type: "string", format: "date", maxLength: 10 },
    b: { type: "boolean", minLength: 1 },
    raw: { type: "string", format: "byte", maxLength: 8 },
    n: { type: "integer", format: "unix-timestamp", maxLength: 3 },
    s: { type: "string", maxLength: 5, pattern: "^a" },
    arr: { type: "array", items: { type: "string" }, maxLength: 2, minItems: 1 },
    num: { type: "number", pattern: "^1", minimum: 0 },
  },
};

describe("validators on a scalar that does not accept them", () => {
  it("generates TypeSpec the real compiler accepts, keeps the constraints stored, and warns", async () => {
    const r = parseJsonSchemaDocument(JSON.stringify(SCHEMA));
    if (!r.success) throw new Error(r.error.message);
    const entity = r.data.entities[0];

    const { source, rows } = generateFor(entity);
    const compiled = await compileTypeSpecWithGovernance(source);
    if (!compiled.success) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n") + "\n" + source);

    // still applied where valid
    expect(source).toMatch(/@maxLength\(5\)\s+@pattern\("\^a"\)\s+s\?: string/);
    expect(source).toMatch(/@minItems\(1\)\s+arr\?: string\[\]/);
    expect(source).toMatch(/@minValue\(0\)\s+num\?: float64/);
    expect(source).not.toMatch(/@maxLength\(30\)/);

    // withheld, not deleted
    const ts = rows.find((x) => x.name === "ts")!;
    expect(JSON.stringify(ts.decorators)).toContain("maxLength");
    expect(JSON.stringify(ts.decorators)).toContain("pattern");

    expect(r.data.warnings.join("\n")).toMatch(/R\.ts.*maxLength.*not applied.*utcDateTime/i);
    expect(r.data.warnings.join("\n")).toMatch(/R\.b.*minLength.*not applied.*boolean/i);
  }, 60_000);
});
