/**
 * The TypeSpec Save keeps the difference between optional (`a?: T`) and nullable (`a: T | null`): what the text says about the null in
 * a field's type is read back (compiled path: `nullableType`; text path: the `| null` of the type), so the field row says the same as the
 * source the Save wrote, and a re-generation writes it again.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));
import { mergeSyncedField, fieldNeedsUpdate, type SyncExistingField, type SyncSourceField } from "@/lib/typespec-sync/merge-fields";

const src = (over: Partial<SyncSourceField> = {}): SyncSourceField => ({
  name: "a", type: "string", isOptional: false, isKey: false, decorators: {}, ...over,
});
const row = (over: Partial<SyncExistingField> = {}): SyncExistingField => ({
  type: "string", nullable: false, isKey: false, description: "", classification: null, decorators: {}, ...over,
});

describe("merge: nullable type vs optional", () => {
  it("required + nullable type: nullable (the column), nullableType and requiredNullable stored", () => {
    const m = mergeSyncedField(null, src({ nullableType: true }));
    expect(m.nullable).toBe(true);
    expect(m.decorators).toMatchObject({ nullableType: true, requiredNullable: true });
  });

  it("optional + nullable type: nullableType only", () => {
    const m = mergeSyncedField(null, src({ isOptional: true, nullableType: true }));
    expect(m.nullable).toBe(true);
    expect(m.decorators.nullableType).toBe(true);
    expect(m.decorators).not.toHaveProperty("requiredNullable");
  });

  it("optional: no flag", () => {
    const m = mergeSyncedField(null, src({ isOptional: true }));
    expect(m.nullable).toBe(true);
    expect(m.decorators).not.toHaveProperty("nullableType");
  });

  it("the text reader (`string | null`) is read the same way", () => {
    const m = mergeSyncedField(null, src({ type: "string | null" }));
    expect(m.type).toBe("string");
    expect(m.nullable).toBe(true);
    expect(m.decorators).toMatchObject({ nullableType: true, requiredNullable: true });
    const optional = mergeSyncedField(null, src({ type: "null | integer", isOptional: true }));
    expect(optional.type).toBe("integer");
    expect(optional.decorators).toMatchObject({ nullableType: true });
    expect(optional.decorators).not.toHaveProperty("requiredNullable");
  });

  it("a source that drops the null drops both flags, a source that keeps it changes nothing", () => {
    const stored = row({ nullable: true, decorators: { nullableType: true, requiredNullable: true } });
    const same = mergeSyncedField(stored, src({ nullableType: true }));
    expect(fieldNeedsUpdate(stored, same, src({ nullableType: true }))).toBe(false);
    const dropped = mergeSyncedField(stored, src());
    expect(dropped.nullable).toBe(false);
    expect(dropped.decorators).not.toHaveProperty("nullableType");
    expect(dropped.decorators).not.toHaveProperty("requiredNullable");
  });

  it("making a required nullable field optional keeps the null type and drops requiredNullable", () => {
    const stored = row({ nullable: true, decorators: { nullableType: true, requiredNullable: true } });
    const m = mergeSyncedField(stored, src({ isOptional: true, nullableType: true }));
    expect(m.decorators.nullableType).toBe(true);
    expect(m.decorators).not.toHaveProperty("requiredNullable");
  });

  it("a stored reference named with `| null` stays that reference", () => {
    const stored = row({ type: "reference", decorators: { referencedEntityName: "Customer" } });
    const m = mergeSyncedField(stored, src({ type: "Customer | null" }));
    expect(m.type).toBe("reference");
    expect(m.decorators.referencedEntityName).toBe("Customer");
    expect(m.decorators.nullableType).toBe(true);
  });
});

describe("the real compiler reader reports the null of a type", () => {
  let compileTypeSpecDocument: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecDocument;
  beforeAll(async () => {
    ({ compileTypeSpecDocument } = await import("@/lib/compiler/typespec-compiler"));
  });

  it("`T | null` is T + nullableType, with or without `?`; arrays and enums too", async () => {
    const doc = await compileTypeSpecDocument(`
      enum Color { red, green }
      model R {
        a: string | null;
        b?: int32 | null;
        c: string[] | null;
        d: Color | null;
        e: string;
      }
    `);
    const by = Object.fromEntries(doc.models[0].fields.map((f) => [f.name, f]));
    expect(by.a).toMatchObject({ type: "string", isOptional: false, nullableType: true });
    expect(by.b).toMatchObject({ type: "int32", isOptional: true, nullableType: true });
    expect(by.c).toMatchObject({ type: "array", arrayElementType: "string", nullableType: true });
    expect(by.d).toMatchObject({ type: "Color", nullableType: true });
    expect(by.e.nullableType).toBeUndefined();
  });
});
