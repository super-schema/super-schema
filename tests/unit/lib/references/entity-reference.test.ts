import { describe, it, expect } from "vitest";
import {
  qualifiedName,
  parseQualifiedName,
  readFieldReference,
  writeFieldReference,
  type EntityRef,
} from "@/lib/references/entity-reference";

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
