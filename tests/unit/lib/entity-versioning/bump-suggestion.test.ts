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
