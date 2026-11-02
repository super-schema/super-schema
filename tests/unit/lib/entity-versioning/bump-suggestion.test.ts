import { describe, it, expect } from "vitest";
import { suggestBump } from "@/lib/entity-versioning/bump-suggestion";
import type { FieldSnapshot } from "@/services/version-history/version.types";

function f(name: string, extra: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return {
    id: `id-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
    fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0,
    ...extra,
  };
}

const ID = f("id", { nullable: false, isKey: true });
const EMAIL = f("email");

describe("suggestBump", () => {
  it("suggests MINOR when nothing changed", () => {
    expect(suggestBump([ID, EMAIL], [ID, EMAIL])).toMatchObject({ bump: "MINOR", summary: { added: 0, removed: 0, modified: 0 } });
  });

  it("suggests MINOR for an added optional field", () => {
    const s = suggestBump([ID, EMAIL], [ID, EMAIL, f("phone")]);
    expect(s.bump).toBe("MINOR");
    expect(s.summary.added).toBe(1);
  });

  it("suggests MINOR for a description-only edit", () => {
    expect(suggestBump([ID, EMAIL], [ID, f("email", { description: "Primary email" })]).bump).toBe("MINOR");
  });

  it("suggests MAJOR for a removed field and says why", () => {
    const s = suggestBump([ID, EMAIL], [ID]);
    expect(s.bump).toBe("MAJOR");
    expect(s.reasons.some((r) => r.includes('Removed field "email"'))).toBe(true);
  });

  it("suggests MAJOR for a type change", () => {
    expect(suggestBump([ID, EMAIL], [ID, f("email", { type: "int32" })]).bump).toBe("MAJOR");
  });

  it("suggests MAJOR for an added required field", () => {
    expect(suggestBump([ID], [ID, f("tenant", { nullable: false })]).bump).toBe("MAJOR");
  });
});

describe("suggestBump for a reference", () => {
  /** A reference field pointing at the entity `id` named `name` (the decorators `writeFieldReference` stores), plus `extra` decorators. */
  const ref = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    f("customer", {
      type: "reference",
      decorators: { referencedEntityId: id, referencedEntityName: name, referencedQualifiedName: `Sales/Orders/${name}`, referencedEntity: name, ...extra },
    });

  it("suggests MAJOR when the reference is re-pointed at another entity, and says why", () => {
    const s = suggestBump([ID, ref("cust", "Customer")], [ID, ref("vend", "Vendor")]);
    expect(s.bump).toBe("MAJOR");
    expect(s.reasons.some((r) => r.includes('Re-pointed reference "customer" from "Sales / Orders / Customer" to "Sales / Orders / Vendor"'))).toBe(true);
  });

  it("suggests MINOR when a legacy name-only reference gains the id of the entity it already named", () => {
    const legacy = f("customer", { type: "reference", decorators: { referencedEntityName: "Customer" } });
    expect(suggestBump([ID, legacy], [ID, ref("cust", "Customer")]).bump).toBe("MINOR");
  });

  it("suggests MINOR when only the version pin of the reference changes", () => {
    expect(suggestBump([ID, ref("cust", "Customer")], [ID, ref("cust", "Customer", { referencedEntityVersion: "2.1" })]).bump).toBe("MINOR");
  });
});
