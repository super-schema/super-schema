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

  it("a resolved reference read back as the bare model name (the real parser output) keeps type and target", () => {
    const existing = row({ type: "reference", decorators: { referencedEntityName: "Customer", governance: { dataCategory: "c" } } });
    for (const type of ["Customer", "Customer | null", "null | Customer"]) {
      const m = mergeSyncedField(existing, src({ type }));
      expect(m.type, type).toBe("reference");
      expect(m.decorators, type).toEqual(existing.decorators);
      expect(fieldNeedsUpdate(existing, m, src({ type }))).toBe(false);
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
