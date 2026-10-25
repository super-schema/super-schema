import { describe, it, expect } from "vitest";
import {
  qualifiedName,
  parseQualifiedName,
  readFieldReference,
  writeFieldReference,
  applyReferencePick,
  withoutReferenceKeys,
  upgradeLegacyReference,
  describeEntityRef,
  describeQualifiedName,
  REFERENCE_DECORATOR_KEYS,
  type EntityRef,
} from "@/lib/references/entity-reference";

// FINAL WAVE 2b, G3: a name may hold "/" (and "%"): the qualified string is encoded, and the three segments are stored on their own,
// so reading a reference never depends on parsing a string that a name could break.
const NAMES: EntityRef[] = [
  { entityId: "e1", domain: "Sales/EU", product: "Orders", entity: "Order" },
  { entityId: "e2", domain: "D", product: "P/Q", entity: "Order/Line" },
  { entityId: "e3", domain: "100%", product: "a%2Fb", entity: "50% off / sale" },
  { entityId: "e4", domain: "Billing & Co", product: "Order Items", entity: "Order Item" },
  { entityId: "e5", domain: "顧客", product: "製品", entity: "住所/Ünïcode" },
  { entityId: "e6", domain: "/", product: "%", entity: "%25" },
];

describe("names that hold '/', '%', spaces and non-ASCII", () => {
  it.each(NAMES)("qualifiedName always has exactly three parts and parses back to the same segments (%o)", (ref) => {
    const q = qualifiedName(ref);
    expect(q.split("/")).toHaveLength(3);
    expect(parseQualifiedName(q)).toEqual({ domain: ref.domain, product: ref.product, entity: ref.entity });
  });

  it("encodes '/' as %2F and '%' as %25 in a segment, and leaves every other name exactly as it was", () => {
    expect(qualifiedName({ domain: "a/b", product: "p", entity: "100%" })).toBe("a%2Fb/p/100%25");
    expect(qualifiedName({ domain: "Billing & Co", product: "Order Items", entity: "Ünï" })).toBe("Billing & Co/Order Items/Ünï");
  });

  it.each(NAMES)("a written reference round-trips with its id and pin (%o)", (ref) => {
    const withPin: EntityRef = { ...ref, pinnedVersion: "1.2" };
    const out = writeFieldReference({ other: 1 }, withPin);
    expect(out.referencedDomain).toBe(ref.domain);
    expect(out.referencedProduct).toBe(ref.product);
    expect(out.referencedEntity).toBe(ref.entity);
    expect(out.referencedEntityName).toBe(ref.entity);
    expect(readFieldReference(out)).toEqual(withPin);
  });

  it("reads the three segments, not the qualified string, so a damaged display string cannot lose the reference", () => {
    const out = writeFieldReference({}, NAMES[0]);
    expect(readFieldReference({ ...out, referencedQualifiedName: "garbage" })).toEqual(NAMES[0]);
    const withoutDisplay = { ...out };
    delete withoutDisplay.referencedQualifiedName;
    expect(readFieldReference(withoutDisplay)).toEqual(NAMES[0]);
  });

  it("still reads a row stored before the segments existed (a plain qualified string)", () => {
    expect(
      readFieldReference({ referencedEntityId: "e", referencedEntityName: "Order", referencedQualifiedName: "Sales/Orders/Order", referencedEntityVersion: "2.0" })
    ).toEqual({ entityId: "e", domain: "Sales", product: "Orders", entity: "Order", pinnedVersion: "2.0" });
  });

  it("recovers an old row whose ENTITY name holds '/' (stored raw, four parts) from its entity name", () => {
    expect(
      readFieldReference({ referencedEntityId: "e", referencedEntityName: "Order/Line", referencedQualifiedName: "Sales/Orders/Order/Line", referencedEntityVersion: "1.0" })
    ).toEqual({ entityId: "e", domain: "Sales", product: "Orders", entity: "Order/Line", pinnedVersion: "1.0" });
  });

  it("an old row that cannot be split keeps its id and its pin (read as a name the id settles), instead of dropping both", () => {
    expect(
      readFieldReference({ referencedEntityId: "e", referencedEntityName: "Line", referencedQualifiedName: "A/B/C/D/Line", referencedEntityVersion: "1.0" })
    ).toEqual({ legacyName: "Line", entityId: "e", pinnedVersion: "1.0" });
  });

  it("upgrading a legacy row writes the segments, after which it reads as qualified (it is not upgraded again)", () => {
    const legacy = { referencedEntityId: "e", referencedEntityName: "Line", referencedQualifiedName: "A/B/C/D/Line", referencedEntityVersion: "1.0" };
    expect(readFieldReference(legacy)).toHaveProperty("legacyName");
    const upgraded = upgradeLegacyReference(legacy, { entityId: "e", domain: "Sales", product: "Orders", entity: "Order/Line" });
    expect(readFieldReference(upgraded)).toEqual({ entityId: "e", domain: "Sales", product: "Orders", entity: "Order/Line", pinnedVersion: "1.0" });
    expect(readFieldReference(upgraded)).not.toHaveProperty("legacyName");
  });

  it("the segment keys go with the other reference keys when the field stops being a reference", () => {
    expect(REFERENCE_DECORATOR_KEYS).toEqual(expect.arrayContaining(["referencedDomain", "referencedProduct", "referencedEntity"]));
    const out = withoutReferenceKeys(writeFieldReference({ keep: 1 }, NAMES[0]));
    expect(Object.keys(out)).toEqual(["keep"]);
  });

  it("a picked entity with '/' in its names is written with its segments, from the encoded qualified name the picker reports", () => {
    const pick = { referencedEntityName: "Order/Line", referencedEntityId: "e2", referencedQualifiedName: qualifiedName(NAMES[1]) };
    expect(readFieldReference(applyReferencePick({}, pick))).toEqual({ entityId: "e2", domain: "D", product: "P/Q", entity: "Order/Line" });
  });

  it("people read the segments with ' / ', never the encoding", () => {
    expect(describeEntityRef(NAMES[1])).toBe("D / P/Q / Order/Line");
    expect(describeQualifiedName(qualifiedName(NAMES[1]))).toBe("D / P/Q / Order/Line");
    expect(describeQualifiedName("Sales/Orders/Order")).toBe("Sales / Orders / Order");
    expect(describeQualifiedName("not-qualified")).toBe("not-qualified");
  });
});
