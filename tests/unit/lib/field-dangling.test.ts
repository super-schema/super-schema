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
    // every other key stays; the reference identity of a field that is no longer a reference does not (see "a field that stops being a reference")
    expect(next).toMatchObject({ semantics: { description: "when" } });
    expect(next).not.toHaveProperty("referencedEntityName");
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

describe("a field that stops being a reference (decoratorsAfterFieldEdit)", () => {
  const REFERENCE_KEYS = {
    referencedEntityId: "e-addr",
    referencedEntityName: "Address",
    referencedQualifiedName: "Billing/Core/Address",
    referencedEntityVersion: "1.2",
  };
  const keysOf = (d: Record<string, unknown> | undefined) => Object.keys(d ?? {}).filter((k) => k.startsWith("referenced"));

  it("retyped to a plain type: the reference, its id and its pin are gone, every other key stays", () => {
    const existing = { type: "reference", decorators: { ...REFERENCE_KEYS, semantics: { description: "x" } } };

    const sent = decoratorsAfterFieldEdit(existing, { type: "string", decorators: { ...REFERENCE_KEYS, semantics: { description: "x" }, typespec: {} } });

    expect(keysOf(sent)).toEqual([]);
    expect(sent).toMatchObject({ semantics: { description: "x" }, typespec: {} });
  });

  it("retyped without sending decorators: the stored ones are cleaned and written", () => {
    const next = decoratorsAfterFieldEdit({ type: "reference", decorators: { ...REFERENCE_KEYS, keep: 1 } }, { type: "int32" });

    expect(keysOf(next)).toEqual([]);
    expect(next).toMatchObject({ keep: 1 });
  });

  it("an array whose elements stop being references loses them; an array of references keeps them", () => {
    const arr = { type: "array", decorators: { arrayElementType: "reference", ...REFERENCE_KEYS } };

    expect(keysOf(decoratorsAfterFieldEdit(arr, { decorators: { arrayElementType: "string", ...REFERENCE_KEYS } }))).toEqual([]);
    expect(keysOf(decoratorsAfterFieldEdit(arr, { type: "string" }))).toEqual([]);
    const kept = { arrayElementType: "reference", ...REFERENCE_KEYS, description: "d" };
    expect(decoratorsAfterFieldEdit(arr, { decorators: kept })).toBe(kept);
    expect(decoratorsAfterFieldEdit(arr, {})).toBeUndefined();
  });

  it("a map whose values stop being references loses them; a map of references keeps them", () => {
    const map = { type: "map", decorators: { mapKeyType: "string", mapValueType: "reference", ...REFERENCE_KEYS } };

    expect(keysOf(decoratorsAfterFieldEdit(map, { decorators: { mapKeyType: "string", mapValueType: "integer", ...REFERENCE_KEYS } }))).toEqual([]);
    expect(decoratorsAfterFieldEdit(map, {})).toBeUndefined();
  });

  it("an array that turns into a reference field (or a reference into an array of strings) is judged by what it is NOW", () => {
    expect(keysOf(decoratorsAfterFieldEdit({ type: "reference", decorators: REFERENCE_KEYS }, { type: "array" }))).toEqual([]);
    const asReference = decoratorsAfterFieldEdit({ type: "array", decorators: { arrayElementType: "string" } }, { type: "reference", decorators: { ...REFERENCE_KEYS } });
    expect(keysOf(asReference)).toEqual(Object.keys(REFERENCE_KEYS));
  });

  it("a reference edited in other ways keeps its reference and its pin", () => {
    const existing = { type: "reference", decorators: REFERENCE_KEYS };
    const sent = { ...REFERENCE_KEYS, semantics: { description: "new" } };

    expect(decoratorsAfterFieldEdit(existing, { decorators: sent })).toBe(sent);
    expect(decoratorsAfterFieldEdit(existing, {})).toBeUndefined();
  });

  it("changing the TARGET drops the pin of the old one, unless the edit pins something itself", () => {
    const existing = { type: "reference", decorators: REFERENCE_KEYS };
    const retargeted = { ...REFERENCE_KEYS, referencedEntityId: "e-money", referencedEntityName: "Money", referencedQualifiedName: "Billing/Core/Money" };

    const cleared = decoratorsAfterFieldEdit(existing, { decorators: retargeted });
    expect(cleared).not.toHaveProperty("referencedEntityVersion");
    expect(cleared).toMatchObject({ referencedEntityId: "e-money", referencedQualifiedName: "Billing/Core/Money" });

    const repinned = decoratorsAfterFieldEdit(existing, { decorators: { ...retargeted, referencedEntityVersion: "3.0" } });
    expect(repinned).toMatchObject({ referencedEntityVersion: "3.0" });
  });

  it("an ARRAY of references whose element target changes drops the pin the edit carried along; one that keeps its target keeps the pin", () => {
    const list = { type: "array", decorators: { arrayElementType: "reference", ...REFERENCE_KEYS } };
    const retargeted = { arrayElementType: "reference", ...REFERENCE_KEYS, referencedEntityId: "e-money", referencedEntityName: "Money", referencedQualifiedName: "Billing/Core/Money" };

    const cleared = decoratorsAfterFieldEdit(list, { decorators: retargeted });
    expect(cleared).not.toHaveProperty("referencedEntityVersion");
    expect(cleared).toMatchObject({ arrayElementType: "reference", referencedEntityId: "e-money" });

    const kept = { arrayElementType: "reference", ...REFERENCE_KEYS, description: "d" };
    expect(decoratorsAfterFieldEdit(list, { decorators: kept })).toBe(kept);
    expect(decoratorsAfterFieldEdit(list, { decorators: { ...retargeted, referencedEntityVersion: "3.0" } })).toMatchObject({ referencedEntityVersion: "3.0" });
  });

  it("a MAP of references whose value target changes drops the pin as well", () => {
    const map = { type: "map", decorators: { mapKeyType: "string", mapValueType: "reference", ...REFERENCE_KEYS } };

    const cleared = decoratorsAfterFieldEdit(map, {
      decorators: { mapKeyType: "string", mapValueType: "reference", ...REFERENCE_KEYS, referencedEntityId: "e-money", referencedEntityName: "Money", referencedQualifiedName: "Billing/Core/Money" },
    });

    expect(cleared).not.toHaveProperty("referencedEntityVersion");
    expect(cleared).toMatchObject({ mapValueType: "reference", referencedEntityId: "e-money" });
  });

  it("an array of references retargeted by NAME only (a name-only reference) drops the pin too", () => {
    const list = { type: "array", decorators: { arrayElementType: "reference", referencedEntityName: "Address", referencedEntityVersion: "1.0" } };

    expect(
      decoratorsAfterFieldEdit(list, { decorators: { arrayElementType: "reference", referencedEntityName: "Money", referencedEntityVersion: "1.0" } }),
    ).not.toHaveProperty("referencedEntityVersion");
  });

  it("a name-only (legacy) reference retargeted by name drops a pin as well", () => {
    const existing = { type: "reference", decorators: { referencedEntityName: "Address", referencedEntityVersion: "1.0" } };

    expect(decoratorsAfterFieldEdit(existing, { decorators: { referencedEntityName: "Money", referencedEntityVersion: "1.0" } })).not.toHaveProperty("referencedEntityVersion");
  });

  it("a field that never was a reference is left alone", () => {
    const plain = { type: "string", decorators: { semantics: { description: "x" } } };
    expect(decoratorsAfterFieldEdit(plain, { type: "int32" })).toBeUndefined();
  });

  it("does not pollute the prototype", () => {
    const decorators = JSON.parse('{"__proto__": {"polluted": true}, "referencedEntityId": "e1"}');
    const next = decoratorsAfterFieldEdit({ type: "reference", decorators }, { type: "string", decorators });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(keysOf(next)).toEqual([]);
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
