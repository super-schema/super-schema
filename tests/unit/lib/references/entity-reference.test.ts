import { describe, it, expect } from "vitest";
import {
  qualifiedName,
  parseQualifiedName,
  readFieldReference,
  writeFieldReference,
  applyReferencePick,
  holdsEntityReference,
  referencePickChangesNothing,
  withoutReferenceKeys,
  REFERENCE_DECORATOR_KEYS,
  type EntityRef,
} from "@/lib/references/entity-reference";

describe("referencePickChangesNothing (the same target picked again)", () => {
  // (the stored form carries the three names on their own since final wave 2b, G3)
  const stored = {
    keep: { a: 1, b: [1, 2] },
    referencedEntityName: "Address",
    referencedEntityId: "e-addr",
    referencedQualifiedName: "Billing/Core/Address",
    referencedDomain: "Billing",
    referencedProduct: "Core",
    referencedEntity: "Address",
  };
  const same = { referencedEntityName: "Address", referencedEntityId: "e-addr", referencedQualifiedName: "Billing/Core/Address" };

  it("is true for the target the field already points at, whatever order its keys were stored in", () => {
    expect(referencePickChangesNothing(stored, same)).toBe(true);
    const shuffled = {
      referencedEntity: "Address", referencedQualifiedName: "Billing/Core/Address", keep: { b: [1, 2], a: 1 }, referencedEntityId: "e-addr",
      referencedProduct: "Core", referencedEntityName: "Address", referencedDomain: "Billing",
    };
    expect(referencePickChangesNothing(shuffled, same)).toBe(true);
  });

  it("is a change for a row stored before the three names were: the pick writes them (it upgrades the row)", () => {
    const { referencedDomain, referencedProduct, referencedEntity, ...old } = stored;
    void referencedDomain; void referencedProduct; void referencedEntity;
    expect(referencePickChangesNothing(old, same)).toBe(false);
  });

  it("is false for another target, for a typed name over a qualified reference, and for a field with no reference yet", () => {
    expect(referencePickChangesNothing(stored, { referencedEntityName: "Money", referencedEntityId: "e-money", referencedQualifiedName: "Billing/Core/Money" })).toBe(false);
    expect(referencePickChangesNothing(stored, { referencedEntityName: "Address" })).toBe(false);
    expect(referencePickChangesNothing({ keep: 1 }, same)).toBe(false);
  });

  it("is false when the field is PINNED: a pick writes no pin, so re-picking the same target drops it", () => {
    expect(referencePickChangesNothing({ ...stored, referencedEntityVersion: "1.2" }, same)).toBe(false);
  });

  it("is false when the same entity was renamed (the qualified name changes)", () => {
    expect(referencePickChangesNothing(stored, { ...same, referencedEntityName: "Address2", referencedQualifiedName: "Billing/Core/Address2" })).toBe(false);
  });
});

describe("holdsEntityReference (does a field of this type carry an entity reference?)", () => {
  it("a reference field does; so does an array of references and a map of references", () => {
    expect(holdsEntityReference("reference", {})).toBe(true);
    expect(holdsEntityReference("array", { arrayElementType: "reference" })).toBe(true);
    expect(holdsEntityReference("map", { mapKeyType: "string", mapValueType: "reference" })).toBe(true);
  });

  it("nothing else does, whatever its decorators still hold", () => {
    const stale = { referencedEntityId: "e1", referencedEntityName: "Address", referencedQualifiedName: "a/b/Address" };
    expect(holdsEntityReference("string", stale)).toBe(false);
    expect(holdsEntityReference("array", { ...stale, arrayElementType: "string" })).toBe(false);
    expect(holdsEntityReference("array", stale)).toBe(false);
    expect(holdsEntityReference("map", { ...stale, mapValueType: "integer" })).toBe(false);
    // a map KEY of reference type is not a reference to an entity
    expect(holdsEntityReference("map", { ...stale, mapKeyType: "reference", mapValueType: "string" })).toBe(false);
  });

  it("a caller that does not know the type gets the answer it always had: yes", () => {
    expect(holdsEntityReference(undefined, { referencedEntityId: "e1" })).toBe(true);
  });

  it("reads own properties of anything that is not a plain object as no element type", () => {
    for (const bad of [null, undefined, "x", 3, []]) expect(holdsEntityReference("array", bad)).toBe(false);
    expect(holdsEntityReference("array", Object.create({ arrayElementType: "reference" }))).toBe(false);
  });
});

describe("withoutReferenceKeys", () => {
  it("drops the reference identity, id and pin, keeps every other key, and returns a copy", () => {
    const decorators = { referencedEntityId: "e", referencedEntityName: "A", referencedQualifiedName: "a/b/A", referencedEntityVersion: "1.0", semantics: { description: "x" }, arrayElementType: "string" };
    const out = withoutReferenceKeys(decorators);
    expect(Object.keys(out).sort()).toEqual(["arrayElementType", "semantics"]);
    expect(out).not.toBe(decorators);
    expect([...REFERENCE_DECORATOR_KEYS].sort()).toEqual([
      "referencedDomain", "referencedEntity", "referencedEntityId", "referencedEntityName", "referencedEntityVersion", "referencedProduct", "referencedQualifiedName",
    ]);
  });
});

describe("entity-reference", () => {
  it("qualifiedName joins domain/product/entity with _tenant placeholders", () => {
    const ref: EntityRef = { domain: "_tenant", product: "_tenant", entity: "Address" };
    expect(qualifiedName(ref)).toBe("_tenant/_tenant/Address");
    expect(parseQualifiedName(qualifiedName(ref))).toEqual(ref);
  });

  it("parseQualifiedName rejects wrong segment counts and empty segments", () => {
    expect(parseQualifiedName("a/b")).toBeUndefined();
    expect(parseQualifiedName("a/b/c/d")).toBeUndefined();
    expect(parseQualifiedName("a//c")).toBeUndefined();
    expect(parseQualifiedName("")).toBeUndefined();
    expect(parseQualifiedName("a/b/c")).toEqual({ domain: "a", product: "b", entity: "c" });
  });

  it("reads a legacy name-only reference", () => {
    expect(readFieldReference({ referencedEntityName: "Address" })).toEqual({ legacyName: "Address" });
    expect(readFieldReference({})).toBeUndefined();
    expect(readFieldReference(null)).toBeUndefined();
  });

  it("round-trips a written reference", () => {
    const ref: EntityRef = { entityId: "e1", domain: "sales", product: "orders", entity: "Order", pinnedVersion: "2" };
    const out = writeFieldReference({ other: 1 }, ref);
    expect(out.referencedEntityId).toBe("e1");
    expect(out.referencedEntityName).toBe("Order");
    expect(out.referencedQualifiedName).toBe("sales/orders/Order");
    expect(out.referencedEntityVersion).toBe("2");
    expect(out.other).toBe(1);
    expect(readFieldReference(out)).toEqual(ref);
  });

  it("stores no version unless pinned", () => {
    const out = writeFieldReference({ referencedEntityVersion: "1" }, { domain: "d", product: "p", entity: "E" });
    expect("referencedEntityVersion" in out).toBe(false);
    expect(readFieldReference(out)).toEqual({ domain: "d", product: "p", entity: "E" });
  });

  it("does not pollute the prototype", () => {
    const decorators = JSON.parse('{"__proto__": {"polluted": true}}');
    writeFieldReference(decorators, { domain: "d", product: "p", entity: "E" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(readFieldReference(JSON.parse('{"__proto__": {"referencedQualifiedName": "a/b/c"}}'))).toBeUndefined();
  });

  it("keeps the prototype intact and an own __proto__ key on write", () => {
    const decorators = JSON.parse('{"__proto__": {"polluted": true}}');
    const out = writeFieldReference(decorators, { domain: "d", product: "p", entity: "E" });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(out.polluted).toBeUndefined();
  });

  it("falls back to legacy when the qualified name is malformed", () => {
    expect(readFieldReference({ referencedQualifiedName: "a/b", referencedEntityName: "Address" })).toEqual({
      legacyName: "Address",
    });
    expect(readFieldReference({ referencedQualifiedName: "a/b" })).toBeUndefined();
  });
});

describe("applyReferencePick (the type picker's choice written onto a reference field's decorators)", () => {
  const picked = { referencedEntityName: "Address", referencedEntityId: "e-addr", referencedQualifiedName: "Billing/Core/Address" };

  it("a picked entity is written fully qualified, with its id", () => {
    const out = applyReferencePick({ other: 1 }, picked);
    expect(out.other).toBe(1);
    expect(readFieldReference(out)).toEqual({ entityId: "e-addr", domain: "Billing", product: "Core", entity: "Address" });
  });

  it("never writes a version, and re-pointing the reference drops the pin of the old target", () => {
    const out = applyReferencePick(
      { referencedEntityId: "old", referencedQualifiedName: "A/B/Old", referencedEntityName: "Old", referencedEntityVersion: "1.2" },
      picked,
    );
    expect("referencedEntityVersion" in out).toBe(false);
    expect(readFieldReference(out)).toEqual({ entityId: "e-addr", domain: "Billing", product: "Core", entity: "Address" });
  });

  it("a typed name that was not picked stays name-only, and drops the id, qualified name and pin of an earlier target", () => {
    const out = applyReferencePick(
      { referencedEntityId: "old", referencedQualifiedName: "A/B/Old", referencedEntityName: "Old", referencedEntityVersion: "1.2", keep: true },
      { referencedEntityName: "Unknown" },
    );
    expect(readFieldReference(out)).toEqual({ legacyName: "Unknown" });
    expect(out.keep).toBe(true);
    expect("referencedEntityId" in out).toBe(false);
    expect("referencedEntityVersion" in out).toBe(false);
  });

  it("a pick without a usable id or qualified name is written as a name, not as a half-qualified reference", () => {
    expect(readFieldReference(applyReferencePick({}, { referencedEntityName: "Address", referencedEntityId: "e1" }))).toEqual({ legacyName: "Address" });
    expect(readFieldReference(applyReferencePick({}, { referencedEntityName: "Address", referencedQualifiedName: "a/b" }))).toEqual({ legacyName: "Address" });
  });

  it("returns an untouched copy when there is no name at all, and does not pollute the prototype", () => {
    const decorators = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}');
    const out = applyReferencePick(decorators, {});
    expect(out.x).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out).not.toBe(decorators);
  });
});
