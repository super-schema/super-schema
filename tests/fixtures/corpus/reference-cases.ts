/**
 * Entities that reference other entities, as the database holds them: fully qualified references (`referencedEntityId` + `domain / product
 * / entity`, written by the same `writeFieldReference` the app uses) between entities of one tenant, with a placement of their own
 * (domain / product / tenant level). The case's own entity is the ROOT; `siblings` are the rest of the tenant. The corpus generates the
 * root's REFERENCE CLOSURE on the five schema targets (one file per entity, see tests/helpers/corpus/run-case.ts) and validates every file.
 *
 * What each case is about (each is also asserted on in tests/integration/corpus/reference-closure.test.ts):
 *   ref-chain                  transitive chain Order -> Customer -> Address
 *   ref-cycle-two              Parent <-> Child
 *   ref-self-reference         Category refers to itself (a field, an array of itself)
 *   ref-array-and-map          an array of references and a map of references, next to a plain reference
 *   ref-same-name-two-products Customer in Retail and Customer in Wholesale, both reached by one entity (qualified-name collision)
 *   ref-tenant-level           entities with no product, and with no domain either
 *   ref-pinned                 a reference pinned to a published version whose fields differ from the live ones: the pin wins
 *   ref-dangling-qualified     a qualified reference to an entity that was deleted, in an entity that references nothing else
 *   ref-dangling-in-closure    the same next to a reference that resolves: the dangling field stays untyped (a warning), nothing fails
 *   ref-ambiguous-bare-name    a legacy name-only reference that two entities answer to: refused with both candidates
 */
import { writeFieldReference } from "@/lib/references/entity-reference";
import type { CorpusCase, CorpusExpectations, ModelInput, Placement } from "./types";

type F = ModelInput["fields"][number];

const SALES: Placement = { domain: "Sales", product: "Orders" };
const RETAIL: Placement = { domain: "Sales", product: "Retail" };
const WHOLESALE: Placement = { domain: "Sales", product: "Wholesale" };

/** Who a reference points at, as the field's decorators record it. */
interface Target {
  id: string;
  name: string;
  place?: Placement;
  /** A pin: a published version of the target (`1.0`). */
  pin?: string;
}

const refDecorators = (to: Target): Record<string, unknown> =>
  writeFieldReference({}, {
    entityId: to.id,
    domain: (to.place ?? SALES).domain ?? "_tenant",
    product: (to.place ?? SALES).product ?? "_tenant",
    entity: to.name,
    ...(to.pin ? { pinnedVersion: to.pin } : {}),
  });

const key = (name = "id", type = "string"): F => ({ name, type, isKey: true, nullable: false });
const text = (name: string, nullable = true): F => ({ name, type: "string", nullable });
const refField = (name: string, to: Target, nullable = true): F => ({ name, type: "reference", nullable, decorators: refDecorators(to) });
const arrayOf = (name: string, to: Target): F => ({ name, type: "array", nullable: true, decorators: { arrayElementType: "reference", ...refDecorators(to) } });
const mapOf = (name: string, to: Target): F => ({ name, type: "map", nullable: true, decorators: { mapKeyType: "string", mapValueType: "reference", ...refDecorators(to) } });
/** A reference by name only, as every reference stored before the qualified form is. */
const legacyRef = (name: string, entityName: string): F => ({ name, type: "reference", nullable: true, decorators: { referencedEntityName: entityName } });

const ROOT = (name: string): Target => ({ id: "e1", name });

function reference(id: string, title: string, input: ModelInput, tags: string[], expectations: CorpusExpectations = {}): CorpusCase {
  return { id: `ref-${id}`, title, kind: "model", source: input, tags: ["model", "reference", ...tags], expectations: { roundTrip: false, ...expectations } };
}

const ADDRESS: Target = { id: "addr", name: "Address" };
const CUSTOMER: Target = { id: "cust", name: "Customer" };

export const REFERENCE_CASES: CorpusCase[] = [
  reference("chain", "transitive chain: PurchaseOrder -> Customer -> Address", {
    entity: { name: "PurchaseOrder" }, place: SALES,
    fields: [key(), text("note"), refField("buyer", CUSTOMER, false)],
    siblings: [
      { entity: { id: "cust", name: "Customer" }, place: SALES, fields: [key(), text("email", false), refField("home", ADDRESS)] },
      { entity: { id: "addr", name: "Address" }, place: SALES, fields: [key(), text("city", false), { name: "zip", type: "string", nullable: true }] },
      // never reached from Order: must not be in the closure
      { entity: { id: "other", name: "Unrelated" }, place: SALES, fields: [key(), text("x")] },
    ],
  }, ["chain", "transitive"]),

  reference("cycle-two", "cycle: Parent <-> Child", {
    entity: { name: "Parent" }, place: SALES,
    fields: [key(), text("label"), arrayOf("children", { id: "child", name: "Child" })],
    siblings: [{ entity: { id: "child", name: "Child" }, place: SALES, fields: [key(), text("name"), refField("parent", ROOT("Parent"))] }],
  }, ["cycle"], {
    // Imports must be acyclic, so the members of a cycle share one package and one .proto file, and the app says so.
    expectedDegraded: [{ target: "protobuf", reason: "a reference cycle shares one Protobuf package and file (warning)" }],
  }),

  reference("self-reference", "self-reference: a Category with a parent and children", {
    entity: { name: "Category" }, place: SALES,
    fields: [key(), text("name", false), refField("parent", ROOT("Category")), arrayOf("children", ROOT("Category"))],
  }, ["cycle", "self"]),

  reference("array-and-map", "an array of references, a map of references and a plain reference to one entity", {
    entity: { name: "Catalog" }, place: SALES,
    fields: [key(), refField("featured", { id: "item", name: "Item" }), arrayOf("items", { id: "item", name: "Item" }), mapOf("bySku", { id: "item", name: "Item" })],
    siblings: [{ entity: { id: "item", name: "Item" }, place: SALES, fields: [key(), text("sku", false), { name: "price", type: "int32", nullable: true }] }],
  }, ["array", "map"]),

  reference("same-name-two-products", "Customer in Retail and Customer in Wholesale, both reached from one PurchaseOrder", {
    entity: { name: "PurchaseOrder" }, place: SALES,
    fields: [
      key(),
      refField("retailBuyer", { id: "cust-retail", name: "Customer", place: RETAIL }),
      refField("wholesaleBuyer", { id: "cust-wholesale", name: "Customer", place: WHOLESALE }),
    ],
    siblings: [
      { entity: { id: "cust-retail", name: "Customer" }, place: RETAIL, fields: [key(), text("loyaltyCard")] },
      { entity: { id: "cust-wholesale", name: "Customer" }, place: WHOLESALE, fields: [key(), text("accountManager", false)] },
    ],
  }, ["collision", "qualified-name"]),

  reference("tenant-level", "references to an entity with a domain but no product, and to one with neither", {
    entity: { name: "Ledger" }, place: SALES,
    fields: [key(), refField("account", { id: "account", name: "Account", place: { domain: "Billing" } }), refField("tax", { id: "tax", name: "TaxCode", place: {} })],
    siblings: [
      { entity: { id: "account", name: "Account" }, place: { domain: "Billing" }, fields: [key(), text("iban")] },
      { entity: { id: "tax", name: "TaxCode" }, place: {}, fields: [key("code"), { name: "rate", type: "float64", nullable: false }] },
    ],
  }, ["tenant-level"]),

  reference("pinned", "a reference pinned to the published 1.0 of Address (the live Address has moved on)", {
    entity: { name: "Customer" }, place: SALES,
    fields: [key(), refField("home", { ...ADDRESS, pin: "1.0" })],
    siblings: [{
      entity: { id: "addr", name: "Address" }, place: SALES,
      // the live (draft) Address: what an unpinned reference would generate
      fields: [key(), text("street", false), text("city", false), text("zip"), text("geohash")],
      // the published 1.0 the pin names: its own, smaller set of fields
      published: [{ version: "1.0", fields: [key(), text("street", false), text("city", false)] }],
    }],
  }, ["pin"]),

  // A reference to an entity that no longer exists is dangling: the closure resolver leaves it out (no error). What the emitter then
  // does depends on the closure: with other entities in it the field is emitted untyped with a warning (below); an entity that is a
  // closure of one still names the missing type and the compiler refuses it (the known issue `reference-to-missing-entity`).
  reference("dangling-qualified", "a qualified reference to an entity that no longer exists (the entity has no other reference)", {
    entity: { name: "Shipment" }, place: SALES,
    fields: [key(), refField("carrier", { id: "gone", name: "Carrier" })],
    siblings: [{ entity: { id: "unrelated", name: "Warehouse" }, place: SALES, fields: [key(), text("site")] }],
  }, ["dangling"]),

  reference("dangling-in-closure", "a reference to a deleted entity next to one that resolves: the deleted one stays untyped, with a warning", {
    entity: { name: "Dispatch" }, place: SALES,
    fields: [key(), refField("from", { id: "wh", name: "Warehouse" }), refField("carrier", { id: "gone", name: "Carrier" }), legacyRef("driver", "Nobody")],
    siblings: [{ entity: { id: "wh", name: "Warehouse" }, place: SALES, fields: [key(), text("site")] }],
  }, ["dangling"], {
    expectedDegraded: ["json-schema", "openapi3", "avro", "protobuf", "java-pojo"].map((target) => ({
      target: target as "json-schema", reason: "a reference nothing answers to is emitted untyped, with a warning naming it",
    })),
  }),

  reference("ambiguous-bare-name", "a name-only reference that matches two entities is refused with both candidates", {
    entity: { name: "Invoice" }, place: SALES,
    fields: [key(), legacyRef("customer", "Customer")],
    siblings: [
      { entity: { id: "cust-retail", name: "Customer" }, place: RETAIL, fields: [key(), text("loyaltyCard")] },
      { entity: { id: "cust-wholesale", name: "Customer" }, place: WHOLESALE, fields: [key(), text("accountManager", false)] },
    ],
  }, ["ambiguous", "legacy"]),
];
