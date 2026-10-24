import { describe, it, expect } from "vitest";
import {
  createNameResolver,
  resolveSourceReferences,
  storedReferenceNames,
  type SourceReference,
  type StoredFieldRow,
  type WrittenFieldType,
} from "@/lib/references/source-reference";
import type { EntityRef } from "@/lib/references/entity-reference";

const ref = (entityId: string, domain: string, product: string, entity: string): EntityRef => ({ entityId, domain, product, entity });

const SELF = ref("ent-1", "Sales", "Orders", "Customer");
const ADDRESS_BILLING = ref("addr-1", "Billing", "Payments", "Address");
const ADDRESS_SALES = ref("addr-2", "Sales", "Shipping", "Address");
const NOTE = ref("note-1", "_tenant", "_tenant", "Note");
const ORDER_ITEM = ref("item-1", "Billing & Co", "Order Lines", "Order Item");
const TENANT = [SELF, ADDRESS_BILLING, ADDRESS_SALES, NOTE, ORDER_ITEM];

describe("createNameResolver", () => {
  const resolve = createNameResolver(TENANT);

  it("a bare name with one match is that entity; with several it is ambiguous (sorted by qualified name); with none it is nothing", () => {
    expect(resolve("Note")).toEqual({ target: NOTE });
    expect(resolve("Address")).toEqual({ ambiguous: [ADDRESS_BILLING, ADDRESS_SALES], name: "Address" });
    expect(resolve("Nowhere")).toBeUndefined();
  });

  it("a bare name is matched like the closure's legacy rule: the exact name first, then the name as an identifier", () => {
    expect(resolve("Order_Item")).toEqual({ target: ORDER_ITEM });
    expect(resolve("order_item")).toEqual({ target: ORDER_ITEM });
  });

  it("Domain.Product.Entity is matched on the three segments as the identifiers the generator makes of them", () => {
    expect(resolve("Billing.Payments.Address")).toEqual({ target: ADDRESS_BILLING });
    expect(resolve("Sales.Shipping.Address")).toEqual({ target: ADDRESS_SALES });
    expect(resolve("_tenant._tenant.Note")).toEqual({ target: NOTE });
    expect(resolve("Billing___Co.Order_Lines.Order_Item")).toEqual({ target: ORDER_ITEM });
  });

  it("a qualified name is exact (segments are case-sensitive) and is never matched piecemeal", () => {
    expect(resolve("billing.payments.address")).toBeUndefined();
    expect(resolve("Billing.Payments.Nowhere")).toBeUndefined();
    expect(resolve("Billing.Shipping.Address")).toBeUndefined();
  });

  it("two segments, four segments or an empty segment is not a name an entity can have", () => {
    for (const written of ["Payments.Address", "A.B.C.D", "A..B", ".A", "A.", "", "..."]) {
      expect(resolve(written), written).toBeUndefined();
    }
  });

  it("two entities whose qualified names read alike as identifiers are ambiguous, both offered", () => {
    const a = ref("x-1", "A-B", "P", "E");
    const b = ref("x-2", "A_B", "P", "E");
    expect(createNameResolver([a, b])("A_B.P.E")).toEqual({ ambiguous: [a, b], name: "A_B.P.E" });
  });
});

const field = (name: string, written: string, shape: WrittenFieldType["shape"] = "direct"): WrittenFieldType => ({ field: name, written, shape });
/** What `resolveSourceReferences` answers when every field resolves and none is unknown. */
const resolvedAs = (entries: Array<[string, SourceReference]>) => ({ ok: true, unresolved: [], references: new Map(entries) });
const row = (id: string, name: string, type: string, decorators: Record<string, unknown> = {}): StoredFieldRow => ({ id, name, type, decorators });
const self = { entityId: "ent-1", modelName: "Customer" };
const qualified = (r: EntityRef) => ({ referencedEntityId: r.entityId, referencedEntityName: r.entity, referencedQualifiedName: `${r.domain}/${r.product}/${r.entity}` });

const resolveFields = (fields: WrittenFieldType[], stored: StoredFieldRow[] = [], picks?: unknown) =>
  resolveSourceReferences({ fields, stored: new Map(stored.map((s) => [s.name, s])), self, refs: TENANT, picks });

describe("resolveSourceReferences", () => {
  it("a bare name with one match, and a qualified name, resolve to the entity (shape says how the field holds it)", () => {
    const out = resolveFields([
      field("note", "Note"),
      field("home", "Billing.Payments.Address"),
      field("homes", "Sales.Shipping.Address", "array"),
      field("byKey", "Note", "map"),
    ]);

    expect(out).toEqual(
      resolvedAs([
        ["note", { ref: NOTE, shape: "direct" }],
        ["home", { ref: ADDRESS_BILLING, shape: "direct" }],
        ["homes", { ref: ADDRESS_SALES, shape: "array" }],
        ["byKey", { ref: NOTE, shape: "map" }],
      ]),
    );
  });

  it("the entity's own model name is the entity itself, even when the tenant has other entities of that name", () => {
    const twin = ref("cust-2", "Marketing", "Leads", "Customer");
    const out = resolveSourceReferences({ fields: [field("parent", "Customer")], stored: new Map(), self, refs: [...TENANT, twin] });

    expect(out).toEqual(resolvedAs([["parent", { ref: SELF, shape: "direct" }]]));
  });

  it("a name no entity has is listed as unresolved, unless the field already refers to that very name (a deleted entity's reference is kept)", () => {
    const gone = [row("f-1", "kept", "reference", { referencedEntityName: "Gone" })];

    expect(resolveFields([field("kept", "Gone"), field("fresh", "Gone"), field("fresh2", "Missing.Product.Thing")], gone)).toEqual({
      ok: true,
      references: new Map([["kept", { keep: true, shape: "direct" }]]),
      unresolved: [field("fresh", "Gone"), field("fresh2", "Missing.Product.Thing")],
    });
  });

  it("a name with several matches stops at the first such field, naming the row that holds it (empty for a field with no row)", () => {
    expect(resolveFields([field("note", "Note"), field("address", "Address")])).toEqual({
      ok: false,
      ambiguous: { field: "address", name: "Address", candidates: [ADDRESS_BILLING, ADDRESS_SALES], fieldId: "" },
    });
    expect(resolveFields([field("address", "Address")], [row("f-1", "address", "string")])).toMatchObject({
      ok: false,
      ambiguous: { fieldId: "f-1" },
    });
  });

  it("a pick must be one of the candidates; anything else is ignored and the question is asked again", () => {
    expect(resolveFields([field("address", "Address")], [], { address: "addr-2" })).toEqual(resolvedAs([["address", { ref: ADDRESS_SALES, shape: "direct" }]]));
    for (const picks of [{ address: "note-1" }, { address: "ent-1" }, { address: "" }, { address: 7 }, { other: "addr-1" }, null, "addr-1", ["addr-1"], undefined]) {
      expect(resolveFields([field("address", "Address")], [], picks), JSON.stringify(picks)).toMatchObject({ ok: false });
    }
  });

  it("a pick is read as an own key only (a hostile __proto__ / constructor key picks nothing)", () => {
    const picks = JSON.parse('{"__proto__": "addr-1", "constructor": "addr-1"}');
    expect(resolveFields([field("__proto__", "Address"), field("constructor", "Address")], [], { toString: "addr-1" })).toMatchObject({ ok: false });
    // own keys named like Object.prototype members DO work as picks for a field of that name
    expect(resolveFields([field("constructor", "Address")], [], picks)).toEqual(resolvedAs([["constructor", { ref: ADDRESS_BILLING, shape: "direct" }]]));
  });

  describe("a reference the row already stores", () => {
    it("a qualified one, written as the same name, is kept (the id is the key): no question even though the name is shared", () => {
      const stored = [row("f-1", "address", "reference", qualified(ADDRESS_SALES))];

      expect(resolveFields([field("address", "Address")], stored)).toEqual(resolvedAs([["address", { keep: true, shape: "direct" }]]));
    });

    it("a qualified one, written as the identifier its name is spelled as (`Order Item` -> `Order_Item`), is kept", () => {
      const stored = [row("f-1", "item", "reference", qualified(ORDER_ITEM))];

      expect(resolveFields([field("item", "Order_Item")], stored)).toEqual(resolvedAs([["item", { keep: true, shape: "direct" }]]));
      expect(resolveFields([field("item", "Billing___Co.Order_Lines.Order_Item")], stored)).toEqual(resolvedAs([["item", { keep: true, shape: "direct" }]]));
    });

    it("a qualified one, written as the Domain.Product.Entity it stored, is kept too (even when that entity has since been renamed: the id is the key)", () => {
      const stored = [row("f-1", "address", "reference", qualified(ADDRESS_SALES))];

      expect(resolveFields([field("address", "Sales.Shipping.Address")], stored)).toEqual(resolvedAs([["address", { keep: true, shape: "direct" }]]));
      // the entity was renamed: neither spelling is found any more, and neither is a question or an unknown name
      for (const written of ["Sales.Shipping.Address", "Address"]) {
        const renamed = resolveSourceReferences({
          fields: [field("address", written)],
          stored: new Map(stored.map((s) => [s.name, s])),
          self,
          refs: [SELF, { ...ADDRESS_SALES, entity: "Location" }],
        });
        expect(renamed, written).toEqual(resolvedAs([["address", { keep: true, shape: "direct" }]]));
      }
    });

    it("the same for an array of references and for a map of references", () => {
      const array = [row("f-1", "addresses", "array", { arrayElementType: "reference", ...qualified(ADDRESS_SALES) })];
      expect(resolveFields([field("addresses", "Address", "array")], array)).toEqual(resolvedAs([["addresses", { keep: true, shape: "array" }]]));

      const map = [row("f-2", "byKey", "map", { mapValueType: "reference", ...qualified(ADDRESS_SALES) })];
      expect(resolveFields([field("byKey", "Address", "map")], map)).toEqual(resolvedAs([["byKey", { keep: true, shape: "map" }]]));
    });

    it("a legacy name-only one is upgraded when the name has one match, asked about when it has several, kept when it has none", () => {
      const legacy = (name: string) => [row("f-1", "x", "reference", { referencedEntityName: name })];

      expect(resolveFields([field("x", "Note")], legacy("Note"))).toEqual(resolvedAs([["x", { ref: NOTE, shape: "direct" }]]));
      expect(resolveFields([field("x", "Address")], legacy("Address"))).toMatchObject({ ok: false, ambiguous: { fieldId: "f-1" } });
      expect(resolveFields([field("x", "Gone")], legacy("Gone"))).toEqual(resolvedAs([["x", { keep: true, shape: "direct" }]]));
    });

    it("another name is a new reference: the stored one does not decide it", () => {
      const stored = [row("f-1", "x", "reference", qualified(ADDRESS_BILLING))];

      expect(resolveFields([field("x", "Note")], stored)).toEqual(resolvedAs([["x", { ref: NOTE, shape: "direct" }]]));
    });

    it("a stored reference of the other shape (direct, array, map) does not count as the same", () => {
      const direct = [row("f-1", "x", "reference", qualified(ADDRESS_SALES))];
      expect(resolveFields([field("x", "Address", "array")], direct)).toMatchObject({ ok: false });
      expect(resolveFields([field("x", "Address", "map")], direct)).toMatchObject({ ok: false });
      const array = [row("f-2", "y", "array", { arrayElementType: "reference", ...qualified(ADDRESS_SALES) })];
      expect(resolveFields([field("y", "Address")], array)).toMatchObject({ ok: false });
      expect(resolveFields([field("y", "Address", "map")], array)).toMatchObject({ ok: false });
    });
  });

  describe("the entity's own name does not overwrite what a field stores", () => {
    const RIVAL = ref("cust-2", "Marketing", "Leads", "Customer");
    const withRival = (fields: WrittenFieldType[], stored: StoredFieldRow[], picks?: unknown) =>
      resolveSourceReferences({ fields, stored: new Map(stored.map((s) => [s.name, s])), self, refs: [...TENANT, RIVAL], picks });

    it("a stored qualified reference to ANOTHER entity of that name, written `Customer`, is kept: not turned into a self-reference", () => {
      const stored = [row("f-1", "rival", "reference", { ...qualified(RIVAL), referencedEntityVersion: "1.0" })];

      expect(withRival([field("rival", "Customer")], stored)).toEqual(resolvedAs([["rival", { keep: true, shape: "direct" }]]));
    });

    it("a stored qualified self-reference is kept too", () => {
      const stored = [row("f-1", "parent", "reference", qualified(SELF))];

      expect(withRival([field("parent", "Customer")], stored)).toEqual(resolvedAs([["parent", { keep: true, shape: "direct" }]]));
    });

    it("a LEGACY name-only reference named like the entity is asked about, the entity itself among the candidates", () => {
      const stored = [row("f-1", "rival", "reference", { referencedEntityName: "Customer" })];

      const asked = withRival([field("rival", "Customer")], stored);
      expect(asked).toMatchObject({ ok: false, ambiguous: { field: "rival", fieldId: "f-1" } });
      if (!asked.ok) expect(asked.ambiguous.candidates.map((c) => c.entityId).sort()).toEqual(["cust-2", "ent-1"]);

      expect(withRival([field("rival", "Customer")], stored, { rival: "ent-1" })).toEqual(resolvedAs([["rival", { ref: SELF, shape: "direct" }]]));
      expect(withRival([field("rival", "Customer")], stored, { rival: "cust-2" })).toEqual(resolvedAs([["rival", { ref: RIVAL, shape: "direct" }]]));
    });

    it("a legacy reference named like the entity, when no other entity has that name, is upgraded to the self-reference", () => {
      const stored = [row("f-1", "parent", "reference", { referencedEntityName: "Customer" })];

      expect(resolveFields([field("parent", "Customer")], stored)).toEqual(resolvedAs([["parent", { ref: SELF, shape: "direct" }]]));
    });

    it("a field with no row, or one that stores no reference (a string, or a reference to another name), typed with the entity's name IS a self-reference", () => {
      const stored = [row("f-1", "plain", "string"), row("f-2", "other", "reference", qualified(ADDRESS_BILLING))];

      expect(withRival([field("fresh", "Customer"), field("plain", "Customer"), field("other", "Customer")], stored)).toEqual(
        resolvedAs([
          ["fresh", { ref: SELF, shape: "direct" }],
          ["plain", { ref: SELF, shape: "direct" }],
          ["other", { ref: SELF, shape: "direct" }],
        ]),
      );
    });
  });
});

describe("storedReferenceNames", () => {
  it("lists the target name of every stored reference (direct, an array's elements, a map's values), qualified or legacy, as the identifier it is spelled as, and the dotted spelling of a qualified one", () => {
    expect([
      ...storedReferenceNames([
        row("1", "a", "reference", qualified(ADDRESS_SALES)),
        row("2", "b", "reference", { referencedEntityName: "Legacy" }),
        row("3", "c", "array", { arrayElementType: "reference", referencedEntityName: "Item" }),
        row("4", "d", "reference", qualified(ORDER_ITEM)),
        row("5", "e", "map", { mapValueType: "reference", referencedEntityName: "Pair" }),
      ]),
    ].sort()).toEqual(["Address", "Billing___Co.Order_Lines.Order_Item", "Item", "Legacy", "Order Item", "Order_Item", "Pair", "Sales.Shipping.Address"]);
  });

  it("does not list a field that is not a reference, a stale name left on a retyped field, or a dangling raw $ref", () => {
    expect([
      ...storedReferenceNames([
        row("1", "a", "string", { referencedEntityName: "Stale" }),
        row("2", "b", "array", { arrayElementType: "string", referencedEntityName: "Stale2" }),
        row("3", "c", "reference", { referencedEntityName: "date_time", danglingRef: { ref: "common/date_time.json", reason: "r" } }),
        row("4", "d", "reference", {}),
      ]),
    ]).toEqual([]);
  });

  it("tolerates rows that are not what it expects", () => {
    expect([...storedReferenceNames([{ name: "x" } as unknown as StoredFieldRow, null as unknown as StoredFieldRow])]).toEqual([]);
  });
});
