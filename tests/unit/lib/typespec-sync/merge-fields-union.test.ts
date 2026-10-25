/**
 * KD-030: a Save of the TypeSpec tab turned every union field into a plain string (the text `A | B` was stored as the literal type, which
 * compiles back to `string`). A union of scalars, of types the source declares, or one the row already was, is read back as a union field
 * (`type: union`, `unionName`, `unionMembers`; an array of one: `arrayElementType: union`). A union that names an entity of the tenant (that
 * only had to compile) keeps being stored as the text, unless the row already is that union.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));
import { mergeSyncedField, fieldNeedsUpdate, type SyncExistingField, type SyncSourceField } from "@/lib/typespec-sync/merge-fields";

const src = (over: Partial<SyncSourceField> = {}): SyncSourceField => ({
  name: "v", type: "string", isOptional: false, isKey: false, decorators: {}, ...over,
});
const row = (over: Partial<SyncExistingField> = {}): SyncExistingField => ({
  type: "string", nullable: false, isKey: false, description: "", classification: null, decorators: {}, ...over,
});

describe("scalar unions", () => {
  it("an inline `string | integer` from the compiler reader is a union field with its members", () => {
    const m = mergeSyncedField(null, src({ type: "string | integer", unionMembers: ["string", "integer"] }));
    expect(m.type).toBe("union");
    expect(m.decorators).toMatchObject({ unionMembers: ["string", "integer"] });
    expect(m.decorators).not.toHaveProperty("unionName");
  });

  it("the text reader (no members) reads the same union from `A | B`", () => {
    const m = mergeSyncedField(null, src({ type: "string | utcDateTime" }));
    expect(m.type).toBe("union");
    expect(m.decorators.unionMembers).toEqual(["string", "utcDateTime"]);
  });

  it("a null in the text is the field's null type, not a member", () => {
    const m = mergeSyncedField(null, src({ type: "string | integer | null" }));
    expect(m.type).toBe("union");
    expect(m.decorators.unionMembers).toEqual(["string", "integer"]);
    expect(m.decorators).toMatchObject({ nullableType: true });
  });

  it("an array of a union is an array whose element is a union", () => {
    const m = mergeSyncedField(null, src({ type: "array", arrayElementType: "union", unionMembers: ["string", "integer"] }));
    expect(m.type).toBe("array");
    expect(m.decorators).toMatchObject({ arrayElementType: "union", unionMembers: ["string", "integer"] });
  });

  it("a union of one type (two spellings of string) is not a union", () => {
    const m = mergeSyncedField(null, src({ type: "string | string" }));
    expect(m.type).toBe("string | string");
    expect(m.decorators).not.toHaveProperty("unionMembers");
  });
});

describe("named unions", () => {
  it("a field typed with a declared union keeps its name and members", () => {
    const m = mergeSyncedField(null, src({ type: "string | integer", unionName: "Id", unionMembers: ["string", "integer"] }));
    expect(m.type).toBe("union");
    expect(m.decorators).toMatchObject({ unionName: "Id", unionMembers: ["string", "integer"] });
  });

  it("members that are declared in the source (models, enums, scalars, unions) count", () => {
    const named = src({ type: "Card | Bank", unionMembers: ["Card", "Bank"] });
    expect(mergeSyncedField(null, named).type).toBe("Card | Bank");
    const declared = mergeSyncedField(null, named, { declared: new Set(["Card", "Bank"]) });
    expect(declared.type).toBe("union");
    expect(declared.decorators.unionMembers).toEqual(["Card", "Bank"]);
  });
});

describe("a row that is already a union", () => {
  const stored = row({ type: "union", decorators: { unionName: "R_v_Union", unionMembers: ["string", "integer"] } });

  it("a Save with the same members changes nothing (name kept)", () => {
    const source = src({ type: "string | integer", unionMembers: ["string", "integer"] });
    const m = mergeSyncedField(stored, source);
    expect(m.type).toBe("union");
    expect(m.decorators).toEqual(stored.decorators);
    expect(fieldNeedsUpdate(stored, m, source)).toBe(false);
  });

  it("another member list is an edit: the members change and the stale declared name goes", () => {
    const m = mergeSyncedField(stored, src({ type: "string | boolean", unionMembers: ["string", "boolean"] }));
    expect(m.type).toBe("union");
    expect(m.decorators.unionMembers).toEqual(["string", "boolean"]);
    expect(m.decorators).not.toHaveProperty("unionName");
  });

  it("retyping to a plain scalar leaves the union (and its keys)", () => {
    const m = mergeSyncedField(stored, src({ type: "string" }));
    expect(m.type).toBe("string");
    expect(m.decorators).not.toHaveProperty("unionMembers");
    expect(m.decorators).not.toHaveProperty("unionName");
  });

  it("a union of entities that the row already is stays that union when the text names the same members", () => {
    const entities = row({ type: "union", decorators: { unionName: "R_m_Union", unionMembers: ["Card", "Bank"] } });
    const source = src({ type: "Card | Bank", unionMembers: ["Card", "Bank"] });
    const m = mergeSyncedField(entities, source);
    expect(m.type).toBe("union");
    expect(m.decorators).toEqual(entities.decorators);
    expect(fieldNeedsUpdate(entities, m, source)).toBe(false);
  });

  it("an array of unions that the row already is stays one", () => {
    const array = row({ type: "array", decorators: { arrayElementType: "union", unionName: "R_t_Union", unionMembers: ["string", "integer"] } });
    const source = src({ type: "array", arrayElementType: "union", unionMembers: ["string", "integer"] });
    const m = mergeSyncedField(array, source);
    expect(m.decorators).toEqual(array.decorators);
    expect(fieldNeedsUpdate(array, m, source)).toBe(false);
  });
});

describe("the real compiler reader reports unions", () => {
  let compileTypeSpecDocument: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecDocument;
  beforeAll(async () => {
    ({ compileTypeSpecDocument } = await import("@/lib/compiler/typespec-compiler"));
  });

  it("inline, named and array-of unions carry their members and name; a union of literals carries none", async () => {
    const doc = await compileTypeSpecDocument(`
      union Id { string, integer }
      model R {
        a: string | integer;
        b: Id;
        c: (string | int64)[];
        d: "x" | "y";
        e: string | integer | null;
      }
    `);
    const by = Object.fromEntries(doc.models[0].fields.map((f) => [f.name, f]));
    expect(by.a).toMatchObject({ type: "string | integer", unionMembers: ["string", "integer"] });
    expect(by.a.unionName).toBeUndefined();
    expect(by.b).toMatchObject({ unionName: "Id", unionMembers: ["string", "integer"] });
    expect(by.c).toMatchObject({ type: "array", arrayElementType: "union", unionMembers: ["string", "int64"] });
    expect(by.d.unionMembers).toBeUndefined();
    expect(by.e).toMatchObject({ unionMembers: ["string", "integer"], nullableType: true });
  });
});
