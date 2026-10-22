import { describe, expect, it } from "vitest";
import { activeDanglingRef, decoratorsAfterFieldEdit, readDanglingMarker } from "@/lib/field-dangling";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { generateEntityAlerts } from "@/lib/validation/entity-alerts";
import { getTargetRequirements } from "@/lib/schema-targets/requirements";

const MARKER = { ref: "common/date_time.json", reason: "x" };
const decorators = { referencedEntityName: "date_time", danglingRef: MARKER, semantics: { description: "when" } };

describe("activeDanglingRef", () => {
  it("is active for a direct reference and for an array of references", () => {
    expect(activeDanglingRef("reference", { danglingRef: { ref: "a.json" } })).toEqual({ ref: "a.json" });
    expect(activeDanglingRef("array", { danglingRef: { ref: "a.json", element: true }, arrayElementType: "reference" })).toEqual({ ref: "a.json", element: true });
  });

  it.each(["string", "int32", "object", "map", "enum", "union"])("ignores a stale marker on a %s field", (type) => {
    expect(activeDanglingRef(type, { danglingRef: { ref: "a.json" } })).toBeUndefined();
    expect(activeDanglingRef(type, { danglingRef: { ref: "a.json", element: true }, arrayElementType: "reference" })).toBeUndefined();
  });

  it("ignores mismatched shapes (direct marker on an array, element marker on a reference, array of non-references)", () => {
    expect(activeDanglingRef("array", { danglingRef: { ref: "a.json" }, arrayElementType: "reference" })).toBeUndefined();
    expect(activeDanglingRef("reference", { danglingRef: { ref: "a.json", element: true } })).toBeUndefined();
    expect(activeDanglingRef("array", { danglingRef: { ref: "a.json", element: true }, arrayElementType: "string" })).toBeUndefined();
  });

  it("rejects malformed stored markers", () => {
    for (const bad of [null, "x", [], { ref: "" }, { ref: 1 }]) expect(readDanglingMarker({ danglingRef: bad })).toBeUndefined();
  });
});

describe("decoratorsAfterFieldEdit", () => {
  const existing = { type: "reference", decorators };

  it("clears the whole marker when the type changes away from reference", () => {
    const next = decoratorsAfterFieldEdit(existing, { type: "string" });
    expect(next).toBeDefined();
    expect(next).not.toHaveProperty("danglingRef");
    expect(next).toMatchObject({ referencedEntityName: "date_time", semantics: { description: "when" } });
  });

  it("clears the array-element variant when the array becomes a string array", () => {
    const arr = { type: "array", decorators: { arrayElementType: "reference", danglingRef: { ref: "u.json", element: true } } };
    expect(decoratorsAfterFieldEdit(arr, { decorators: { arrayElementType: "string", danglingRef: { ref: "u.json", element: true } } })).not.toHaveProperty("danglingRef");
    expect(decoratorsAfterFieldEdit(arr, { type: "string" })).not.toHaveProperty("danglingRef");
  });

  it("clears it when the reference target changes", () => {
    expect(decoratorsAfterFieldEdit(existing, { decorators: { ...decorators, referencedEntityName: "Customer" } })).not.toHaveProperty("danglingRef");
  });

  it("keeps it (writes nothing) for an edit that leaves the field the same reference", () => {
    expect(decoratorsAfterFieldEdit(existing, {})).toBeUndefined();
    expect(decoratorsAfterFieldEdit(existing, { type: "reference" })).toBeUndefined();
    expect(decoratorsAfterFieldEdit(existing, { decorators })).toBe(decorators);
  });

  it("changing only the description-like decorators keeps the marker the client sent", () => {
    const sent = { ...decorators, semantics: { description: "new" } };
    expect(decoratorsAfterFieldEdit(existing, { decorators: sent })).toMatchObject({ danglingRef: MARKER });
  });

  it("passes everything through for a field without a marker", () => {
    const plain = { type: "string", decorators: { semantics: { description: "x" } } };
    expect(decoratorsAfterFieldEdit(plain, { type: "int32" })).toBeUndefined();
    const sent = { semantics: { description: "y" } };
    expect(decoratorsAfterFieldEdit(plain, { decorators: sent })).toBe(sent);
  });
});

describe("a stale marker after the user resolves the field (end to end at unit level)", () => {
  const entity = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
  const row = (type: string, dec: Record<string, unknown>): PrismaFieldInput => ({
    id: "f1", name: "created_time", type, precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "",
    classification: null, aliases: [], decorators: dec, sortOrder: 0,
  });

  it("changed to string: no alert, key allowed, TypeSpec is string", () => {
    // The edit path: the stored decorators after decoratorsAfterFieldEdit for type -> string.
    const afterEdit = decoratorsAfterFieldEdit({ type: "reference", decorators }, { type: "string" })!;
    const field = row("string", afterEdit);
    expect(generateEntityAlerts({ description: "d", metadata: {} }, [{ id: "f1", name: "created_time", type: "string", description: "x", classification: null, decorators: afterEdit }]).some((a) => a.id === "entity-unresolved-references")).toBe(false);
    expect(getTargetRequirements("bigquery", { name: "Evt", fields: [{ name: "created_time", type: "string", isKey: false, nullable: false, dangling: activeDanglingRef("string", afterEdit) !== undefined }] }).missing[0].candidates).toEqual(["created_time"]);
    const source = generateTypeSpec(compileEntity(entity, [field]), { governance: false });
    expect(source).toContain("created_time: string;");
    expect(source).not.toContain("unknown");
  });

  it("even if the marker is left behind (stale), every reader ignores it", () => {
    const stale = row("string", decorators);
    const model = compileEntity(entity, [stale]);
    expect(model.fields[0].danglingRef).toBeUndefined();
    const source = generateTypeSpec(model, { governance: false });
    expect(source).toContain("created_time: string;");
    expect(source).not.toContain('extension("$ref"');
    expect(generateEntityAlerts({ description: "d", metadata: {} }, [{ id: "f1", name: "created_time", type: "string", description: "x", classification: null, decorators }]).some((a) => a.id === "entity-unresolved-references")).toBe(false);
  });

  it("a field that stays a reference keeps the marker (alert, unknown, no key candidate)", () => {
    const keep = row("reference", decorators);
    const model = compileEntity(entity, [keep]);
    expect(model.fields[0].danglingRef).toEqual({ ref: "common/date_time.json" });
    expect(generateTypeSpec(model, { governance: false })).toContain("created_time: unknown;");
    expect(generateEntityAlerts({ description: "d", metadata: {} }, [{ id: "f1", name: "created_time", type: "reference", description: "x", classification: null, decorators }]).some((a) => a.id === "entity-unresolved-references")).toBe(true);
  });
});
