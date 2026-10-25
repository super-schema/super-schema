/**
 * Optional (the property may be ABSENT: not in `required`) is not nullable (the value may be `null`: `type: [T, "null"]`, `anyOf` with
 * `{ type: "null" }`). The IR says both in `nullable` (the column may be NULL), and keeps the difference in `nullableType` (the value may
 * be null) and `requiredNullable` (the property must be present even though it may be null), so the TypeSpec text can say
 * `a: string | null` (required + nullable), `a?: string | null` (optional + nullable) or `a?: string` (optional).
 */
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { buildDecoratorsFromParsedField } from "@/lib/importers/decorator-builder";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";

function importDoc(schema: unknown) {
  const r = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}
const props = {
  req: { type: "string" },
  reqNull: { type: ["string", "null"] },
  optNull: { type: ["integer", "null"] },
  opt: { type: "string" },
  reqAnyOfNull: { anyOf: [{ type: "string" }, { type: "null" }] },
  optOneOfNull: { oneOf: [{ type: "string" }, { type: "null" }] },
  justNull: { type: "null" },
};
const doc = importDoc({ title: "R", type: "object", required: ["req", "reqNull", "reqAnyOfNull", "justNull"], properties: props });
const f = (name: string) => doc.entities[0].fields.find((x) => x.name === name)!;

describe("nullable is not optional", () => {
  it("required + a null type: present, may be null", () => {
    expect(f("reqNull")).toMatchObject({ nullable: true, nullableType: true, requiredNullable: true });
    expect(f("reqAnyOfNull")).toMatchObject({ nullable: true, nullableType: true, requiredNullable: true });
  });

  it("optional + a null type: may be absent and may be null", () => {
    expect(f("optNull")).toMatchObject({ nullable: true, nullableType: true });
    expect(f("optNull").requiredNullable).toBeUndefined();
    expect(f("optOneOfNull")).toMatchObject({ nullable: true, nullableType: true });
  });

  it("optional without a null type: only absent", () => {
    expect(f("opt").nullable).toBe(true);
    expect(f("opt").nullableType).toBeUndefined();
    expect(f("opt").requiredNullable).toBeUndefined();
  });

  it("required without a null type: neither", () => {
    expect(f("req").nullable).toBe(false);
    expect(f("req").nullableType).toBeUndefined();
  });

  it("a property that is only `null` keeps what it had (a string, low confidence), no null type flag", () => {
    expect(f("justNull")).toMatchObject({ type: "string", confidence: "low" });
    expect(f("justNull").nullableType).toBeUndefined();
  });

  it("a format next to the null wrapper (what the JSON Schema emitter writes for `string | null` + @format) is the member's format", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { a: { anyOf: [{ type: "string" }, { type: "null" }], format: "uuid" }, b: { anyOf: [{ type: "string" }, { type: "null" }], format: "date-time" } },
    });
    expect(d.entities[0].fields.find((x) => x.name === "a")).toMatchObject({ type: "string", format: "uuid", nullableType: true });
    expect(d.entities[0].fields.find((x) => x.name === "b")).toMatchObject({ type: "utcDateTime", nullableType: true });
  });

  it("both flags are persisted in the decorators (read by compileEntity)", () => {
    expect(buildDecoratorsFromParsedField(f("reqNull"))).toMatchObject({ nullableType: true, requiredNullable: true });
    expect(buildDecoratorsFromParsedField(f("optNull"))).toMatchObject({ nullableType: true });
    expect(buildDecoratorsFromParsedField(f("optNull"))).not.toHaveProperty("requiredNullable");
    expect(buildDecoratorsFromParsedField(f("req"))).not.toHaveProperty("nullableType");
  });
});

describe("the generated TypeSpec says which is which", () => {
  const model = compileEntity(
    { id: "e", name: "R", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "D", slug: "d" } },
    doc.entities[0].fields.map((field, i) => ({
      id: `f${i}`, name: field.name, type: field.type, precision: null, scale: null, nullable: field.nullable, isKey: false, fieldNumber: null,
      description: "", classification: null, aliases: [], decorators: buildDecoratorsFromParsedField(field), sortOrder: i,
    }))
  );
  const text = generateTypeSpec(model, { governance: false });

  it("required + null: `a: T | null` (no `?`)", () => {
    expect(text).toMatch(/\breqNull: string \| null;/);
    expect(text).toMatch(/\breqAnyOfNull: string \| null;/);
  });

  it("optional + null: `a?: T | null`", () => {
    expect(text).toMatch(/\boptNull\?: integer \| null;/);
  });

  it("optional: `a?: T`; required: `a: T`", () => {
    expect(text).toMatch(/\bopt\?: string;/);
    expect(text).toMatch(/\breq: string;/);
  });

  it("a field whose Nullable was switched off is written plain, whatever flags it still carries", () => {
    const off = { ...model, fields: model.fields.map((x) => (x.name === "reqNull" ? { ...x, nullable: false } : x)) };
    expect(generateTypeSpec(off, { governance: false })).toMatch(/\breqNull: string;/);
  });
});
