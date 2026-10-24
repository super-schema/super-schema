import { describe, it, expect } from "vitest";
import {
  createNameResolver,
  resolveSourceReferences,
  storedReferenceNames,
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

const field = (name: string, written: string, element = false): WrittenFieldType => ({ field: name, written, element });
const row = (id: string, name: string, type: string, decorators: Record<string, unknown> = {}): StoredFieldRow => ({ id, name, type, decorators });
const self = { entityId: "ent-1", modelName: "Customer" };
const qualified = (r: EntityRef) => ({ referencedEntityId: r.entityId, referencedEntityName: r.entity, referencedQualifiedName: `${r.domain}/${r.product}/${r.entity}` });

const resolveFields = (fields: WrittenFieldType[], stored: StoredFieldRow[] = [], picks?: unknown) =>
  resolveSourceReferences({ fields, stored: new Map(stored.map((s) => [s.name, s])), self, refs: TENANT, picks });

describe("resolveSourceReferences", () => {
  it("a bare name with one match, and a qualified name, resolve to the entity (element says an array's element)", () => {
    const out = resolveFields([field("note", "Note"), field("home", "Billing.Payments.Address"), field("homes", "Sales.Shipping.Address", true)]);

    expect(out).toEqual({
      ok: true,
      references: new Map([
        ["note", { ref: NOTE, element: false }],
        ["home", { ref: ADDRESS_BILLING, element: false }],
        ["homes", { ref: ADDRESS_SALES, element: true }],
      ]),
    });
  });

  it("the entity's own model name is the entity itself, even when the tenant has other entities of that name", () => {
    const twin = ref("cust-2", "Marketing", "Leads", "Customer");
    const out = resolveSourceReferences({ fields: [field("parent", "Customer")], stored: new Map(), self, refs: [...TENANT, twin] });

    expect(out).toEqual({ ok: true, references: new Map([["parent", { ref: SELF, element: false }]]) });
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
    expect(resolveFields([field("address", "Address")], [], { address: "addr-2" })).toEqual({
      ok: true,
      references: new Map([["address", { ref: ADDRESS_SALES, element: false }]]),
    });
    for (const picks of [{ address: "note-1" }, { address: "ent-1" }, { address: "" }, { address: 7 }, { other: "addr-1" }, null, "addr-1", ["addr-1"], undefined]) {
      expect(resolveFields([field("address", "Address")], [], picks), JSON.stringify(picks)).toMatchObject({ ok: false });
    }
  });

  it("a pick is read as an own key only (a hostile __proto__ / constructor key picks nothing)", () => {
    const picks = JSON.parse('{"__proto__": "addr-1", "constructor": "addr-1"}');
    expect(resolveFields([field("__proto__", "Address"), field("constructor", "Address")], [], { toString: "addr-1" })).toMatchObject({ ok: false });
    // own keys named like Object.prototype members DO work as picks for a field of that name
    expect(resolveFields([field("constructor", "Address")], [], picks)).toEqual({
      ok: true,
      references: new Map([["constructor", { ref: ADDRESS_BILLING, element: false }]]),
    });
  });

  describe("a reference the row already stores", () => {
    it("a qualified one, written as the same name, is left alone (the id is the key): no entry, no question even though the name is shared", () => {
      const stored = [row("f-1", "address", "reference", qualified(ADDRESS_SALES))];

      expect(resolveFields([field("address", "Address")], stored)).toEqual({ ok: true, references: new Map() });
    });

    it("the same for an array of references", () => {
      const stored = [row("f-1", "addresses", "array", { arrayElementType: "reference", ...qualified(ADDRESS_SALES) })];

      expect(resolveFields([field("addresses", "Address", true)], stored)).toEqual({ ok: true, references: new Map() });
    });

    it("a legacy name-only one is upgraded when the name has one match, asked about when it has several, left alone when it has none", () => {
      const legacy = (name: string) => [row("f-1", "x", "reference", { referencedEntityName: name })];

      expect(resolveFields([field("x", "Note")], legacy("Note"))).toEqual({ ok: true, references: new Map([["x", { ref: NOTE, element: false }]]) });
      expect(resolveFields([field("x", "Address")], legacy("Address"))).toMatchObject({ ok: false, ambiguous: { fieldId: "f-1" } });
      expect(resolveFields([field("x", "Gone")], legacy("Gone"))).toEqual({ ok: true, references: new Map() });
    });

    it("another name is a new reference: the stored one does not decide it", () => {
      const stored = [row("f-1", "x", "reference", qualified(ADDRESS_BILLING))];

      expect(resolveFields([field("x", "Note")], stored)).toEqual({ ok: true, references: new Map([["x", { ref: NOTE, element: false }]]) });
    });

    it("a stored reference of the other shape (a direct one for an array's element, an array for a direct name) does not count as the same", () => {
      const direct = [row("f-1", "x", "reference", qualified(ADDRESS_SALES))];
      expect(resolveFields([field("x", "Address", true)], direct)).toMatchObject({ ok: false });
      const array = [row("f-2", "y", "array", { arrayElementType: "reference", ...qualified(ADDRESS_SALES) })];
      expect(resolveFields([field("y", "Address")], array)).toMatchObject({ ok: false });
    });
  });
});

describe("storedReferenceNames", () => {
  it("lists the target name of every stored reference (direct, or an array's elements), qualified or legacy", () => {
    expect([
      ...storedReferenceNames([
        row("1", "a", "reference", qualified(ADDRESS_SALES)),
        row("2", "b", "reference", { referencedEntityName: "Legacy" }),
        row("3", "c", "array", { arrayElementType: "reference", referencedEntityName: "Item" }),
      ]),
    ].sort()).toEqual(["Address", "Item", "Legacy"]);
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
