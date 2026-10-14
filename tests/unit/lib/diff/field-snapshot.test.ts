import { describe, it, expect } from "vitest";
import { toFieldSnapshot } from "@/lib/diff/field-snapshot";

describe("toFieldSnapshot", () => {
  it("copies the compared columns and drops row-only columns", () => {
    const row = {
      id: "f1", entityId: "e1", name: "email", slug: "email", type: "string", precision: null, scale: null,
      nullable: true, isKey: false, fieldNumber: 2, description: "Primary email", classification: "PII",
      aliases: ["mail"], decorators: { typespec: { identity: { format: "email" } } }, sortOrder: 1,
      createdAt: new Date(), updatedAt: new Date(),
    };
    expect(toFieldSnapshot(row)).toEqual({
      id: "f1", name: "email", type: "string", precision: null, scale: null, nullable: true, isKey: false,
      fieldNumber: 2, description: "Primary email", classification: "PII", aliases: ["mail"],
      decorators: { typespec: { identity: { format: "email" } } }, sortOrder: 1,
    });
  });

  it("normalises null decorators to an empty object", () => {
    const snap = toFieldSnapshot({
      id: "f1", name: "id", type: "string", precision: null, scale: null, nullable: false, isKey: true,
      fieldNumber: null, description: "", classification: null, aliases: [], decorators: null, sortOrder: 0,
    });
    expect(snap.decorators).toEqual({});
  });
});
