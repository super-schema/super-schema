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
  it("no field change suggests PATCH", () => {
    expect(suggestBump([ID, EMAIL], [ID, EMAIL])).toMatchObject({ bump: "PATCH", summary: { added: 0, removed: 0, modified: 0 } });
  });

  it("description-only field change suggests PATCH", () => {
    const s = suggestBump([ID, EMAIL], [ID, f("email", { description: "Primary email" })]);
    expect(s.bump).toBe("PATCH");
    expect(s.summary.modified).toBe(1);
  });

  it("a sortOrder-only change (reordering fields) suggests PATCH", () => {
    expect(suggestBump([ID, EMAIL], [f("id", { nullable: false, isKey: true, sortOrder: 1 }), f("email", { sortOrder: 0 })]).bump).toBe("PATCH");
  });

  it("description edits on several fields still suggest PATCH", () => {
    expect(suggestBump([ID, EMAIL], [f("id", { nullable: false, isKey: true, description: "Key" }), f("email", { description: "Mail" })]).bump).toBe("PATCH");
  });

  it("a description edit alongside a non-breaking property change suggests MINOR", () => {
    expect(suggestBump([ID, EMAIL], [ID, f("email", { description: "Primary email", aliases: ["mail"] })]).bump).toBe("MINOR");
  });

  it("a description edit alongside an added optional field suggests MINOR", () => {
    expect(suggestBump([ID, EMAIL], [ID, f("email", { description: "Primary email" }), f("phone")]).bump).toBe("MINOR");
  });

  it("a description edit alongside a type change suggests MAJOR", () => {
    expect(suggestBump([ID, EMAIL], [ID, f("email", { description: "Primary email", type: "int32" })]).bump).toBe("MAJOR");
  });

  it("added optional field suggests MINOR", () => {
    const s = suggestBump([ID, EMAIL], [ID, EMAIL, f("phone")]);
    expect(s.bump).toBe("MINOR");
    expect(s.summary.added).toBe(1);
  });

  it("removed field suggests MAJOR", () => {
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
