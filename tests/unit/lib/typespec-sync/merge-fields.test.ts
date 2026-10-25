/**
 * Task 16 — the TypeSpec-source -> field rows sync MERGES instead of replacing `Field.decorators`.
 * Pure: `mergeSyncedField` (one field) and `entityExtensionsChange` (the model's extensions -> metadata.custom.extensions).
 */
import { describe, it, expect } from "vitest";
import {
  mergeSyncedField,
  fieldNeedsUpdate,
  entityExtensionsChange,
  type SyncExistingField,
  type SyncSourceField,
} from "@/lib/typespec-sync/merge-fields";

const RAW = "common_components/v4/schema/json/openapi-2.0/date_time.json";

const src = (over: Partial<SyncSourceField> = {}): SyncSourceField => ({
  name: "f", type: "string", isOptional: false, isKey: false, decorators: {}, ...over,
});
const row = (over: Partial<SyncExistingField> = {}): SyncExistingField => ({
  type: "string", nullable: false, isKey: false, description: "", classification: null, decorators: {}, ...over,
});

describe("dangling reference round trip", () => {
  it("unknown + $ref extension -> reference with the raw ref, the derived name and a generic reason", () => {
    const m = mergeSyncedField(null, src({ type: "unknown", decorators: { extensions: { $ref: RAW, "x-a": 1 } } }));
    expect(m.type).toBe("reference");
    expect(m.decorators.danglingRef).toEqual({ ref: RAW, reason: "unresolved reference" });
    expect(m.decorators.referencedEntityName).toBe("date_time");
    expect(m.decorators.typespec).toEqual({ extensions: { openapi: { "x-a": 1 } } });
  });

  it("unknown[] + items { $ref } extension -> array of reference with the element variant", () => {
    const m = mergeSyncedField(null, src({ type: "array", arrayElementType: "unknown", decorators: { extensions: { items: { $ref: "user_links.json" } } } }));
    expect(m.type).toBe("array");
    expect(m.decorators.arrayElementType).toBe("reference");
    expect(m.decorators.danglingRef).toEqual({ ref: "user_links.json", element: true, reason: "unresolved reference" });
    expect(m.decorators.referencedEntityName).toBe("user_links");
    expect(m.decorators.typespec).toBeUndefined();
  });

  it("the real-compiler reader reports TypeSpec's unknown as string: the same encoding is decoded (direct and items)", () => {
    const direct = mergeSyncedField(null, src({ type: "string", decorators: { extensions: { $ref: RAW } } }));
    expect(direct.type).toBe("reference");
    expect(direct.decorators.danglingRef).toMatchObject({ ref: RAW });
    const items = mergeSyncedField(null, src({ type: "array", arrayElementType: "string", decorators: { extensions: { items: { $ref: "u.json" } } } }));
    expect(items.decorators.danglingRef).toMatchObject({ ref: "u.json", element: true });
    // a plain string without the extension is just a string
    expect(mergeSyncedField(null, src({ type: "string" })).decorators.danglingRef).toBeUndefined();
  });

  it("keeps the reason of the existing marker", () => {
    const existing = row({ type: "reference", decorators: { referencedEntityName: "date_time", danglingRef: { ref: RAW, reason: "no base URL" } } });
    const m = mergeSyncedField(existing, src({ type: "unknown", decorators: { extensions: { $ref: RAW } } }));
    expect(m.decorators.danglingRef).toEqual({ ref: RAW, reason: "no base URL" });
  });

  it("an items extension that is not exactly { $ref: string } stays an ordinary extension", () => {
    const m = mergeSyncedField(null, src({ type: "array", arrayElementType: "unknown", decorators: { extensions: { items: { $ref: "a.json", type: "string" } } } }));
    expect(m.decorators.danglingRef).toBeUndefined();
    expect(m.type).toBe("array");
    expect((m.decorators.typespec as { extensions: { openapi: unknown } }).extensions.openapi).toEqual({ items: { $ref: "a.json", type: "string" } });
  });

  it("renaming the $ref value updates the marker's raw ref and the derived name", () => {
    const existing = row({ type: "reference", decorators: { referencedEntityName: "date_time", danglingRef: { ref: RAW, reason: "r" } } });
    const m = mergeSyncedField(existing, src({ type: "unknown", decorators: { extensions: { $ref: "other/Thing.json" } } }));
    expect(m.decorators.danglingRef).toEqual({ ref: "other/Thing.json", reason: "r" });
    expect(m.decorators.referencedEntityName).toBe("Thing");
  });

  it("removing the $ref extension and giving the field a real type clears the marker and the derived target", () => {
    const existing = row({ type: "reference", decorators: { referencedEntityName: "date_time", danglingRef: { ref: RAW, reason: "r" }, keep: 1 } });
    const m = mergeSyncedField(existing, src({ type: "string" }));
    expect(m.type).toBe("string");
    expect(m.decorators.danglingRef).toBeUndefined();
    expect(m.decorators.referencedEntityName).toBeUndefined();
    expect(m.decorators.keep).toBe(1);
  });

  it("changing the element type of a dangling array clears the marker", () => {
    const existing = row({ type: "array", decorators: { arrayElementType: "reference", referencedEntityName: "user_links", danglingRef: { ref: "user_links.json", element: true, reason: "r" } } });
    const m = mergeSyncedField(existing, src({ type: "array", arrayElementType: "string" }));
    expect(m.decorators.danglingRef).toBeUndefined();
    expect(m.decorators.referencedEntityName).toBeUndefined();
    expect(m.decorators.arrayElementType).toBe("string");
  });

  it("hostile $ref text round-trips verbatim", () => {
    const hostile = 'a"b\\c${x}\nd`e ';
    const m = mergeSyncedField(null, src({ type: "unknown", decorators: { extensions: { $ref: hostile } } }));
    expect((m.decorators.danglingRef as { ref: string }).ref).toBe(hostile);
  });
});

describe("generic extensions", () => {
  it("are written to typespec.extensions.openapi; other extension buckets and other typespec keys survive", () => {
    const existing = row({ decorators: { typespec: { extensions: { xml: { name: "n" }, openapi: { "x-old": 1 } }, identity: { key: true, format: "uuid" } } } });
    const m = mergeSyncedField(existing, src({ isKey: true, decorators: { extensions: { "x-new": { a: [1] } } } }));
    const ts = m.decorators.typespec as Record<string, Record<string, unknown>>;
    expect(ts.extensions).toEqual({ xml: { name: "n" }, openapi: { "x-new": { a: [1] } } });
    expect(ts.identity).toEqual({ key: true }); // format is source-owned (absent now), key is kept while the field is a key
  });

  it("an __proto__ key survives as an OWN key", () => {
    const ext = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(ext, "__proto__", { value: { p: 1 }, enumerable: true, configurable: true, writable: true });
    const m = mergeSyncedField(null, src({ decorators: { extensions: ext } }));
    const openapi = (m.decorators.typespec as { extensions: { openapi: object } }).extensions.openapi;
    expect(Object.prototype.hasOwnProperty.call(openapi, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(openapi)).toBe(Object.prototype);
  });

  it("an extension removed from the source is removed from the row", () => {
    const existing = row({ decorators: { typespec: { extensions: { openapi: { "x-old": 1 } } } } });
    const m = mergeSyncedField(existing, src());
    expect(m.decorators.typespec).toBeUndefined();
  });
});

describe("preserved keys", () => {
  const rich = (): SyncExistingField =>
    row({
      classification: "class4",
      decorators: {
        classification: { level: "class4" },
        governance: { dataClass: "class4", dataCategory: "Intrinsic", protobufFieldNumber: 7 },
        semantics: { description: "d" },
        mystery: { deep: [1, 2] },
        typespec: { validation: { minLength: 1 }, extensions: { openapi: { "x-securityClassification": { data_class: "class4" } } } },
      },
    });
  const same = (over: Record<string, unknown> = {}) =>
    src({ decorators: { minLength: 1, classification: "class4", extensions: { "x-securityClassification": { data_class: "class4" } }, ...over } });

  it("a no-op merge changes nothing", () => {
    const existing = rich();
    const m = mergeSyncedField(existing, same(), { governanceKnown: true });
    expect(m.decorators).toEqual(existing.decorators);
    expect(fieldNeedsUpdate(existing, m, same())).toBe(false);
  });

  it("governance data category and unknown decorator keys survive an edit of a source-owned key", () => {
    const m = mergeSyncedField(rich(), same({ minLength: 5 }));
    expect((m.decorators.governance as Record<string, unknown>).dataCategory).toBe("Intrinsic");
    expect(m.decorators.mystery).toEqual({ deep: [1, 2] });
    expect((m.decorators.typespec as { validation: unknown }).validation).toEqual({ minLength: 5 });
  });

  it("a changed classification level updates the row and dataClass when dataClass tracked the old level", () => {
    const m = mergeSyncedField(rich(), same({ classification: "class2" }));
    expect(m.classification).toBe("class2");
    expect(m.decorators.classification).toEqual({ level: "class2" });
    expect(m.decorators.governance).toEqual({ dataClass: "class2", dataCategory: "Intrinsic", protobufFieldNumber: 7 });
  });

  it("dataClass that did not equal the old level is left alone", () => {
    const existing = rich();
    (existing.decorators as { governance: Record<string, unknown> }).governance.dataClass = "custom";
    const m = mergeSyncedField(existing, same({ classification: "class2" }));
    expect((m.decorators.governance as Record<string, unknown>).dataClass).toBe("custom");
  });

  it("referencedEntityName / arrayElementType survive when the type is unchanged, are dropped when it changes", () => {
    const existing = row({ type: "reference", decorators: { referencedEntityName: "Customer" } });
    expect(mergeSyncedField(existing, src({ type: "reference" })).decorators.referencedEntityName).toBe("Customer");
    expect(mergeSyncedField(existing, src({ type: "string" })).decorators.referencedEntityName).toBeUndefined();
    const arr = row({ type: "array", decorators: { arrayElementType: "Customer" } });
    expect(mergeSyncedField(arr, src({ type: "array" })).decorators.arrayElementType).toBe("Customer");
  });

  it("a reference retyped in the source loses its id and qualified name too, not only its name (and the pin)", () => {
    const stored = { referencedEntityId: "e1", referencedEntityName: "Customer", referencedQualifiedName: "d/p/Customer", referencedEntityVersion: "1.0", keep: 1 };
    const existing = row({ type: "reference", decorators: { ...stored } });
    const m = mergeSyncedField(existing, src({ type: "string" }));
    expect(m.decorators).toMatchObject({ keep: 1 });
    for (const key of ["referencedEntityId", "referencedEntityName", "referencedQualifiedName", "referencedEntityVersion"]) {
      expect(m.decorators, key).not.toHaveProperty(key);
    }
  });

  it("an array whose element moved off the reference loses its id and qualified name too", () => {
    const existing = row({
      type: "array",
      decorators: { arrayElementType: "reference", referencedEntityId: "e1", referencedEntityName: "Customer", referencedQualifiedName: "d/p/Customer" },
    });
    const edit = mergeSyncedField(existing, src({ type: "array", arrayElementType: "Order" }));
    expect(edit.decorators).not.toHaveProperty("referencedEntityId");
    expect(edit.decorators).not.toHaveProperty("referencedQualifiedName");
  });

  it("a reference that stays the same reference keeps its id and qualified name", () => {
    const decorators = { referencedEntityId: "e1", referencedEntityName: "Customer", referencedQualifiedName: "d/p/Customer" };
    const existing = row({ type: "reference", decorators: { ...decorators } });
    expect(mergeSyncedField(existing, src({ type: "Customer" })).decorators).toEqual(decorators);
  });

  it("a resolved reference read back as the bare model name (the real parser output) keeps type and target", () => {
    const existing = row({ type: "reference", decorators: { referencedEntityName: "Customer", governance: { dataCategory: "c" } } });
    for (const type of ["Customer", "Customer | null", "null | Customer"]) {
      const m = mergeSyncedField(existing, src({ type }));
      expect(m.type, type).toBe("reference");
      if (type === "Customer") {
        expect(m.decorators, type).toEqual(existing.decorators);
        expect(fieldNeedsUpdate(existing, m, src({ type }))).toBe(false);
      } else {
        // The `| null` is the source's statement that the value may be null: stored (merge-fields-nullable.test.ts), the target kept.
        expect(m.decorators, type).toEqual({ ...(existing.decorators as Record<string, unknown>), nullableType: true, requiredNullable: true });
        expect(m.nullable).toBe(true);
      }
    }
    expect(mergeSyncedField(existing, src({ type: "Customer", isOptional: true })).type).toBe("reference");
  });

  it("a bare name that differs from the stored target is a real edit: the new name, target cleared", () => {
    const existing = row({ type: "reference", decorators: { referencedEntityName: "Customer" } });
    for (const type of ["Order", "customer"]) {
      const m = mergeSyncedField(existing, src({ type }));
      expect(m.type).toBe(type);
      expect(m.decorators.referencedEntityName).toBeUndefined();
    }
  });

  it("an array of a resolved reference (Customer[]) keeps array, element reference and target; another element is an edit", () => {
    const existing = row({ type: "array", decorators: { arrayElementType: "reference", referencedEntityName: "Customer" } });
    const m = mergeSyncedField(existing, src({ type: "array", arrayElementType: "Customer" }));
    expect(m.decorators).toEqual(existing.decorators);
    const edit = mergeSyncedField(existing, src({ type: "array", arrayElementType: "Order" }));
    expect(edit.decorators.arrayElementType).toBe("Order");
    expect(edit.decorators.referencedEntityName).toBeUndefined();
  });

  it.each([["string", "string.json"], ["unknown", "#/$defs/unknown"], ["null", "null.json"]])(
    "a dangling field whose target is literally %s keeps its marker on a no-op save (both parsers' carrier types)", (target, ref) => {
      const direct = row({ type: "reference", decorators: { referencedEntityName: target, danglingRef: { ref, reason: "r" } } });
      for (const type of ["string", "unknown"]) {
        const s = src({ type, decorators: { extensions: { $ref: ref } } });
        const m = mergeSyncedField(direct, s);
        expect(m.decorators, `${target}/${type}`).toEqual(direct.decorators);
        expect(m.type).toBe("reference");
        expect(fieldNeedsUpdate(direct, m, s)).toBe(false);
      }
      const arr = row({ type: "array", decorators: { arrayElementType: "reference", referencedEntityName: target, danglingRef: { ref, element: true, reason: "r" } } });
      for (const el of ["string", "unknown"]) {
        const s = src({ type: "array", arrayElementType: el, decorators: { extensions: { items: { $ref: ref } } } });
        const m = mergeSyncedField(arr, s);
        expect(m.decorators, `${target}/${el}[]`).toEqual(arr.decorators);
        expect(fieldNeedsUpdate(arr, m, s)).toBe(false);
      }
    });

  it.each(["string", "unknown", "null"])("a RESOLVED reference to an entity named %s round-trips with its target (compiler and regex carrier types, direct and array)", (name) => {
    const direct = row({ type: "reference", decorators: { referencedEntityName: name, governance: { dataCategory: "c" } } });
    const arr = row({ type: "array", decorators: { arrayElementType: "reference", referencedEntityName: name } });
    for (const type of [name]) {
      const s = src({ type });
      const m = mergeSyncedField(direct, s);
      expect(m.type).toBe("reference");
      expect(m.decorators).toEqual(direct.decorators);
      expect(fieldNeedsUpdate(direct, m, s)).toBe(false);
      const sa = src({ type: "array", arrayElementType: type });
      const ma = mergeSyncedField(arr, sa);
      expect(ma.decorators).toEqual(arr.decorators);
      expect(fieldNeedsUpdate(arr, ma, sa)).toBe(false);
    }
  });

  it("a dangling field whose target is string, retyped to bare string with NO extension, is a real retype to the scalar: marker and target cleared", () => {
    const direct = row({ type: "reference", decorators: { referencedEntityName: "string", danglingRef: { ref: "string.json", reason: "r" } } });
    const m = mergeSyncedField(direct, src({ type: "string" }));
    expect(m.type).toBe("string");
    expect(m.decorators).toEqual({});
    const arr = row({ type: "array", decorators: { arrayElementType: "reference", referencedEntityName: "string", danglingRef: { ref: "string.json", element: true, reason: "r" } } });
    const a = mergeSyncedField(arr, src({ type: "array", arrayElementType: "string" }));
    expect(a.decorators).toEqual({ arrayElementType: "string" });
  });

  it("a dangling field resolved by typing its bare name keeps that target as a plain reference; marker cleared (direct and array)", () => {
    const direct = row({ type: "reference", decorators: { referencedEntityName: "Customer", danglingRef: { ref: "x/Customer.json", reason: "r" } } });
    const d = mergeSyncedField(direct, src({ type: "Customer" }));
    expect(d.type).toBe("reference");
    expect(d.decorators).toEqual({ referencedEntityName: "Customer" });
    const arr = row({ type: "array", decorators: { arrayElementType: "reference", referencedEntityName: "Customer", danglingRef: { ref: "x/Customer.json", element: true, reason: "r" } } });
    const a = mergeSyncedField(arr, src({ type: "array", arrayElementType: "Customer" }));
    expect(a.decorators).toEqual({ arrayElementType: "reference", referencedEntityName: "Customer" });
  });

  it("a dangling field resolved to a DIFFERENT bare name: the new name, target and marker cleared", () => {
    const direct = row({ type: "reference", decorators: { referencedEntityName: "Customer", danglingRef: { ref: "x/Customer.json", reason: "r" } } });
    const d = mergeSyncedField(direct, src({ type: "Order" }));
    expect(d.type).toBe("Order");
    expect(d.decorators).toEqual({});
    const arr = row({ type: "array", decorators: { arrayElementType: "reference", referencedEntityName: "Customer", danglingRef: { ref: "x/Customer.json", element: true, reason: "r" } } });
    const a = mergeSyncedField(arr, src({ type: "array", arrayElementType: "Order" }));
    expect(a.decorators).toEqual({ arrayElementType: "Order" });
  });

  it("enum symbols kept in validation.pattern survive while the field stays an enum", () => {
    const existing = row({ type: "enum", decorators: { enumName: "E", typespec: { validation: { pattern: "A|B" } } } });
    const m = mergeSyncedField(existing, src({ type: "enum" }));
    expect(m.decorators).toEqual(existing.decorators);
  });

  it("a field typed with a declared enum stays an enum with its stored symbols (the compiler names the enum, not `enum`)", () => {
    const existing = row({ type: "enum", decorators: { enumName: "T_state", typespec: { validation: { pattern: "new|done" } } } });
    const m = mergeSyncedField(existing, src({ type: "T_state" }), { enums: new Map([["T_state", ["new", "done"]]]) });
    expect(m.type).toBe("enum");
    expect(m.decorators).toEqual(existing.decorators);
  });

  it("a NEW field typed with a declared enum becomes an enum field carrying the source's symbols", () => {
    const m = mergeSyncedField(null, src({ type: "T_state" }), { enums: new Map([["T_state", ["new", "done"]]]) });
    expect(m.type).toBe("enum");
    expect(m.decorators.enumName).toBe("T_state");
    expect(m.decorators.typespec).toEqual({ validation: { pattern: "new|done" } });
  });

  it("an array of a declared enum stays an array of enum with its stored symbols", () => {
    const existing = row({ type: "array", decorators: { arrayElementType: "enum", enumValues: ["a", "b"] } });
    const m = mergeSyncedField(existing, src({ type: "array", arrayElementType: "T_kind" }), { enums: new Map([["T_kind", ["a", "b"]]]) });
    expect(m.type).toBe("array");
    expect(m.decorators.arrayElementType).toBe("enum");
    expect(m.decorators.enumValues).toEqual(["a", "b"]);
  });

  it("compiled path: source-owned governance keys follow the source, importer-only keys survive", () => {
    const existing = row({ decorators: { governance: { dataClass: "c", pii: true, protobufFieldNumber: 3 } } });
    const none = mergeSyncedField(existing, src(), { governanceKnown: true });
    expect(none.decorators.governance).toEqual({ dataClass: "c", protobufFieldNumber: 3 });
    const set = mergeSyncedField(existing, src(), { governance: { retentionPolicy: "7y" }, governanceKnown: true });
    expect(set.decorators.governance).toEqual({ dataClass: "c", protobufFieldNumber: 3, retentionPolicy: "7y" });
    // the regex path knows nothing about governance: untouched
    expect(mergeSyncedField(existing, src()).decorators.governance).toEqual({ dataClass: "c", pii: true, protobufFieldNumber: 3 });
  });
});

describe("scale", () => {
  it("20000 fields merge without blowing up", () => {
    const t = Date.now();
    for (let i = 0; i < 20000; i++) mergeSyncedField(row({ decorators: { a: i } }), src({ decorators: { extensions: { $ref: `r${i}` } }, type: "unknown" }));
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe("entityExtensionsChange", () => {
  it("none when equal (also both empty, key order irrelevant)", () => {
    expect(entityExtensionsChange(null, undefined)).toEqual({ kind: "none" });
    expect(entityExtensionsChange({ custom: { extensions: { a: 1, b: { c: 2, d: 3 } } } }, { b: { d: 3, c: 2 }, a: 1 })).toEqual({ kind: "none" });
  });
  it("set when different", () => {
    expect(entityExtensionsChange({ tags: ["t"] }, { a: 1 })).toEqual({ kind: "set", value: { a: 1 } });
  });
  it("clear when the source has none and the metadata has some", () => {
    expect(entityExtensionsChange({ custom: { extensions: { a: 1 }, other: 1 } }, undefined)).toEqual({ kind: "clear" });
  });
});

describe("a name the source typed a field with that resolved to an entity of the tenant (Task 11)", () => {
  const BILLING = { entityId: "addr-1", domain: "Billing", product: "Payments", entity: "Address" };
  const SALES = { entityId: "addr-2", domain: "Sales", product: "Shipping", entity: "Address" };
  // (the three names are stored on their own beside the qualified string: final wave 2b, G3)
  const QUALIFIED = (r: typeof BILLING) => ({
    referencedEntityId: r.entityId,
    referencedEntityName: r.entity,
    referencedQualifiedName: `${r.domain}/${r.product}/${r.entity}`,
    referencedDomain: r.domain,
    referencedProduct: r.product,
    referencedEntity: r.entity,
  });

  it("a new field becomes a reference: id, name and qualified name, and NO version", () => {
    const m = mergeSyncedField(null, src({ type: "Address" }), { reference: { ref: BILLING, shape: "direct" } });

    expect(m.type).toBe("reference");
    expect(m.decorators).toEqual(QUALIFIED(BILLING));
  });

  it("an array element: an array whose element is a reference, the target on the field", () => {
    const m = mergeSyncedField(null, src({ type: "array", arrayElementType: "Address" }), { reference: { ref: SALES, shape: "array" } });

    expect(m.type).toBe("array");
    expect(m.decorators).toEqual({ arrayElementType: "reference", ...QUALIFIED(SALES) });
  });

  it("the pin tag of the source is the only version: stored with the reference, otherwise none (a stale pin goes)", () => {
    const pinned = mergeSyncedField(null, src({ type: "Address", decorators: { referencedEntityVersion: "1.2" } }), { reference: { ref: BILLING, shape: "direct" } });
    expect(pinned.decorators).toEqual({ ...QUALIFIED(BILLING), referencedEntityVersion: "1.2" });

    const existing = row({ type: "reference", decorators: { ...QUALIFIED(BILLING), referencedEntityVersion: "1.0" } });
    const unpinned = mergeSyncedField(existing, src({ type: "Address" }), { reference: { ref: BILLING, shape: "direct" } });
    expect(unpinned.decorators).toEqual(QUALIFIED(BILLING));
  });

  it("a legacy name-only reference written as the same name is upgraded in place; other decorators survive", () => {
    const existing = row({ type: "reference", decorators: { referencedEntityName: "Address", governance: { dataCategory: "c" } } });

    const m = mergeSyncedField(existing, src({ type: "Address" }), { reference: { ref: BILLING, shape: "direct" } });

    expect(m.type).toBe("reference");
    expect(m.decorators).toEqual({ ...QUALIFIED(BILLING), governance: { dataCategory: "c" } });
    expect(fieldNeedsUpdate(existing, m, src({ type: "Address" }))).toBe(true);
  });

  it("retargeting replaces the whole target, the id and the qualified name included", () => {
    const existing = row({ type: "reference", decorators: { ...QUALIFIED(BILLING), referencedEntityVersion: "1.0", keep: 1 } });

    const m = mergeSyncedField(existing, src({ type: "Address" }), { reference: { ref: SALES, shape: "direct" } });

    expect(m.decorators).toEqual({ ...QUALIFIED(SALES), keep: 1 });
  });

  it("a field that was a string and is now a reference loses what was bound to the old type", () => {
    const m = mergeSyncedField(row({ type: "string", decorators: { enumName: "E", typespec: { validation: { maxLength: 5 } } } }), src({ type: "Address" }), {
      reference: { ref: BILLING, shape: "direct" },
    });

    expect(m.type).toBe("reference");
    expect(m.decorators).not.toHaveProperty("enumName");
    expect(m.decorators).toMatchObject(QUALIFIED(BILLING));
  });

  it("a dangling field (a raw $ref) typed with a name that resolved is a resolved reference: the marker goes", () => {
    const existing = row({ type: "reference", decorators: { referencedEntityName: "Address", danglingRef: { ref: "common/address.json", reason: "r" } } });

    const m = mergeSyncedField(existing, src({ type: "Address" }), { reference: { ref: BILLING, shape: "direct" } });

    expect(m.decorators).not.toHaveProperty("danglingRef");
    expect(m.decorators).toMatchObject(QUALIFIED(BILLING));
  });

  it("re-saving the same resolved reference changes nothing", () => {
    const existing = row({ type: "reference", decorators: { ...QUALIFIED(BILLING) } });

    const m = mergeSyncedField(existing, src({ type: "Address" }), { reference: { ref: BILLING, shape: "direct" } });

    expect(fieldNeedsUpdate(existing, m, src({ type: "Address" }))).toBe(false);
  });

  it("an id-less reference (a name only) is written without an id, never with a made-up one", () => {
    const m = mergeSyncedField(null, src({ type: "Address" }), { reference: { ref: { domain: "Billing", product: "Payments", entity: "Address" }, shape: "direct" } });

    expect(m.decorators).not.toHaveProperty("referencedEntityId");
    expect(m.decorators.referencedQualifiedName).toBe("Billing/Payments/Address");
  });

  it("a map shape: the field is a map whose values are references (mapValueType reference, the target on the field, the pin tag the only version)", () => {
    const fresh = mergeSyncedField(null, src({ type: "map" }), { reference: { ref: BILLING, shape: "map" } });
    expect(fresh.type).toBe("map");
    expect(fresh.decorators).toEqual({ mapValueType: "reference", ...QUALIFIED(BILLING) });

    const pinned = mergeSyncedField(null, src({ type: "map", decorators: { referencedEntityVersion: "2.0" } }), { reference: { ref: BILLING, shape: "map" } });
    expect(pinned.decorators).toEqual({ mapValueType: "reference", ...QUALIFIED(BILLING), referencedEntityVersion: "2.0" });

    const was = row({ type: "map", decorators: { mapValueType: "string", mapKeyType: "string" } });
    const retyped = mergeSyncedField(was, src({ type: "map" }), { reference: { ref: SALES, shape: "map" } });
    expect(retyped.decorators).toEqual({ mapKeyType: "string", mapValueType: "reference", ...QUALIFIED(SALES) });
  });

  describe("keep: the field already stores that reference and the text names it again", () => {
    const stored = (over: Record<string, unknown> = {}) => ({ ...QUALIFIED(BILLING), referencedEntityVersion: "1.0", keep: 1, ...over });

    it("every stored key stays, whatever the spelling in the text (a name that is not the stored one reads as the reference, not a retype)", () => {
      const existing = row({ type: "reference", decorators: { ...QUALIFIED(BILLING), referencedEntityName: "Order Item", referencedEntityVersion: "1.0" } });

      const m = mergeSyncedField(existing, src({ type: "Order_Item", decorators: { referencedEntityVersion: "1.0" } }), { reference: { keep: true, shape: "direct" } });

      expect(m.type).toBe("reference");
      expect(m.decorators).toEqual(existing.decorators);
      expect(fieldNeedsUpdate(existing, m, src({ type: "Order_Item" }))).toBe(false);
    });

    it("an array and a map of references the same", () => {
      const array = row({ type: "array", decorators: { arrayElementType: "reference", ...QUALIFIED(BILLING), referencedEntityName: "Order Item" } });
      const kept = mergeSyncedField(array, src({ type: "array", arrayElementType: "Order_Item" }), { reference: { keep: true, shape: "array" } });
      expect(kept.type).toBe("array");
      expect(kept.decorators).toEqual(array.decorators);

      const map = row({ type: "map", decorators: { mapValueType: "reference", ...QUALIFIED(BILLING), referencedEntityName: "Order Item" } });
      const keptMap = mergeSyncedField(map, src({ type: "map" }), { reference: { keep: true, shape: "map" } });
      expect(keptMap.type).toBe("map");
      expect(keptMap.decorators).toEqual(map.decorators);
    });

    it("the pin follows the text as always: gone from the tag, gone from the row", () => {
      const existing = row({ type: "reference", decorators: stored() });

      const m = mergeSyncedField(existing, src({ type: "Address" }), { reference: { keep: true, shape: "direct" } });

      expect(m.decorators).toEqual({ ...QUALIFIED(BILLING), keep: 1 });
    });

    it("a legacy reference whose entity is gone is kept as it is", () => {
      const existing = row({ type: "reference", decorators: { referencedEntityName: "Gone Thing" } });

      const m = mergeSyncedField(existing, src({ type: "Gone_Thing" }), { reference: { keep: true, shape: "direct" } });

      expect(m.type).toBe("reference");
      expect(m.decorators).toEqual({ referencedEntityName: "Gone Thing" });
    });
  });

  it("the input is not modified", () => {
    const stored = { referencedEntityName: "Address" };
    const existing = row({ type: "reference", decorators: stored });
    mergeSyncedField(existing, src({ type: "Address" }), { reference: { ref: BILLING, shape: "direct" } });
    expect(stored).toEqual({ referencedEntityName: "Address" });
  });
});
