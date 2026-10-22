import { describe, expect, it } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";

// Found by the corpus (js-meta-number-edges): `"maximum": 9223372036854775807` on an int64 field. JSON.parse reads it as the double
// 2^63, which the generator printed as `@maxValue(9223372036854776000)`; the real compiler rejects that for int64 ("Type
// '9223372036854776000' is not assignable to type 'int64'"), so EVERY official target failed for a schema that merely states the
// type's own limit. A bound outside the scalar's range says nothing the type does not already say.
const entity = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
const field = (type: string, validation: Record<string, unknown>): PrismaFieldInput => ({
  id: "f", name: "v", type, precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", classification: null,
  aliases: [], decorators: { typespec: { validation } }, sortOrder: 0,
});
const source = (f: PrismaFieldInput) => generateTypeSpec(compileEntity(entity, [f]), { governance: false });

describe("numeric bounds that a fixed-range integer type already implies", () => {
  it("drops a maxValue above the int64 maximum (the schema's 9223372036854775807 is read as 2^63)", () => {
    const text = source(field("int64", { maxValue: 9223372036854775807, minValue: -9223372036854775808 }));
    expect(text).toContain("v: int64;");
    expect(text).not.toContain("@maxValue");
    // -2^63 as a double prints as -9223372036854776000, which is below int64's minimum: dropped as well
    expect(text).not.toContain("@minValue");
  });

  it("drops a uint64 maximum and an out-of-range int32 bound, keeps the exact limits", () => {
    expect(source(field("uint64", { maxValue: 18446744073709551615 }))).not.toContain("@maxValue");
    expect(source(field("int32", { maxValue: 2147483648, minValue: -2147483649 }))).not.toMatch(/@m(ax|in)Value/);
    expect(source(field("int32", { maxValue: 2147483647, minValue: -2147483648 }))).toContain("@maxValue(2147483647)");
  });

  it("keeps a bound that is tighter than the type", () => {
    const text = source(field("int64", { maxValue: 100, minValue: 0 }));
    expect(text).toContain("@maxValue(100)");
    expect(text).toContain("@minValue(0)");
    expect(source(field("int32", { maxValue: 2147483646 }))).toContain("@maxValue(2147483646)");
  });

  it("leaves unbounded and floating types alone", () => {
    expect(source(field("integer", { maxValue: 9223372036854775807 }))).toContain("@maxValue(");
    expect(source(field("float64", { maxValue: 1e308 }))).toContain("@maxValue(1e+308)");
  });
});
