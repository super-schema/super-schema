import { describe, it, expect } from "vitest";
import { computeFieldDiff, summarizeChanges } from "@/lib/diff/field-diff";
import type { FieldSnapshot } from "@/services/version-history/version.types";

function makeField(overrides: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return {
    id: "field-1",
    name: "customer_id",
    type: "string",
    precision: null,
    scale: null,
    nullable: false,
    isKey: true,
    fieldNumber: 1,
    description: "Customer identifier",
    classification: "PII",
    aliases: [],
    decorators: {},
    sortOrder: 0,
    ...overrides,
  };
}

describe("computeFieldDiff", () => {
  it("returns empty changes when both snapshots are identical", () => {
    const fields = [makeField()];
    const changes = computeFieldDiff(fields, fields);
    expect(changes).toEqual([]);
  });

  it("returns empty changes when both snapshots are empty", () => {
    const changes = computeFieldDiff([], []);
    expect(changes).toEqual([]);
  });

  it("detects added fields", () => {
    const previous: FieldSnapshot[] = [];
    const current = [makeField({ name: "email" })];

    const changes = computeFieldDiff(previous, current);

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("added");
    expect(changes[0].fieldName).toBe("email");
    expect(changes[0].details.after).toBeDefined();
    expect(changes[0].details.before).toBeUndefined();
  });

  it("detects removed fields", () => {
    const previous = [makeField({ name: "old_field" })];
    const current: FieldSnapshot[] = [];

    const changes = computeFieldDiff(previous, current);

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("removed");
    expect(changes[0].fieldName).toBe("old_field");
    expect(changes[0].details.before).toBeDefined();
    expect(changes[0].details.after).toBeUndefined();
  });

  it("detects modified fields with changed properties", () => {
    const previous = [makeField({ name: "email", type: "string", nullable: true })];
    const current = [makeField({ name: "email", type: "string", nullable: false })];

    const changes = computeFieldDiff(previous, current);

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("modified");
    expect(changes[0].fieldName).toBe("email");
    expect(changes[0].details.changedProperties).toContain("nullable");
    expect(changes[0].details.before).toBeDefined();
    expect(changes[0].details.after).toBeDefined();
  });

  it("detects multiple property changes on a single field", () => {
    const previous = [
      makeField({ name: "amount", type: "integer", description: "Amount" }),
    ];
    const current = [
      makeField({ name: "amount", type: "decimal", description: "Total amount" }),
    ];

    const changes = computeFieldDiff(previous, current);

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("modified");
    expect(changes[0].details.changedProperties).toContain("type");
    expect(changes[0].details.changedProperties).toContain("description");
  });

  it("detects added, removed, and modified fields simultaneously", () => {
    const previous = [
      makeField({ name: "keep_field", type: "string" }),
      makeField({ name: "remove_me", type: "integer", id: "f2" }),
      makeField({ name: "modify_me", type: "string", id: "f3" }),
    ];
    const current = [
      makeField({ name: "keep_field", type: "string" }),
      makeField({ name: "new_field", type: "boolean", id: "f4" }),
      makeField({ name: "modify_me", type: "integer", id: "f3" }), // type changed
    ];

    const changes = computeFieldDiff(previous, current);

    const added = changes.filter((c) => c.type === "added");
    const removed = changes.filter((c) => c.type === "removed");
    const modified = changes.filter((c) => c.type === "modified");

    expect(added).toHaveLength(1);
    expect(added[0].fieldName).toBe("new_field");

    expect(removed).toHaveLength(1);
    expect(removed[0].fieldName).toBe("remove_me");

    expect(modified).toHaveLength(1);
    expect(modified[0].fieldName).toBe("modify_me");
    expect(modified[0].details.changedProperties).toContain("type");
  });

  it("detects decorator changes", () => {
    const previous = [
      makeField({ name: "email", decorators: { validation: { format: "email" } } }),
    ];
    const current = [
      makeField({ name: "email", decorators: { validation: { format: "uri" } } }),
    ];

    const changes = computeFieldDiff(previous, current);

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("modified");
    expect(changes[0].details.changedProperties).toContain("decorators");
  });

  it("detects alias changes", () => {
    const previous = [makeField({ name: "email", aliases: ["e-mail"] })];
    const current = [makeField({ name: "email", aliases: ["e-mail", "email_addr"] })];

    const changes = computeFieldDiff(previous, current);

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("modified");
    expect(changes[0].details.changedProperties).toContain("aliases");
  });

  it("does not report changes when fields are identical", () => {
    const field = makeField({ name: "status", type: "string" });
    const changes = computeFieldDiff([field], [{ ...field }]);
    expect(changes).toHaveLength(0);
  });

  it("sorts changes: added first, then modified, then removed", () => {
    const previous = [
      makeField({ name: "b_remove", id: "f1" }),
      makeField({ name: "c_modify", type: "string", id: "f2" }),
    ];
    const current = [
      makeField({ name: "a_add", id: "f3" }),
      makeField({ name: "c_modify", type: "integer", id: "f2" }),
    ];

    const changes = computeFieldDiff(previous, current);

    expect(changes[0].type).toBe("added");
    expect(changes[1].type).toBe("modified");
    expect(changes[2].type).toBe("removed");
  });
});

describe("summarizeChanges", () => {
  it("returns 'No changes' for empty changes", () => {
    expect(summarizeChanges([])).toBe("No changes");
  });

  it("summarizes added fields", () => {
    const changes = [
      { type: "added" as const, fieldName: "a", details: { changedProperties: [] } },
      { type: "added" as const, fieldName: "b", details: { changedProperties: [] } },
    ];
    expect(summarizeChanges(changes)).toBe("Added 2 fields");
  });

  it("summarizes single added field without plural", () => {
    const changes = [
      { type: "added" as const, fieldName: "a", details: { changedProperties: [] } },
    ];
    expect(summarizeChanges(changes)).toBe("Added 1 field");
  });

  it("summarizes mixed changes", () => {
    const changes = [
      { type: "added" as const, fieldName: "a", details: { changedProperties: [] } },
      { type: "modified" as const, fieldName: "b", details: { changedProperties: ["type"] } },
      { type: "removed" as const, fieldName: "c", details: { changedProperties: [] } },
    ];
    expect(summarizeChanges(changes)).toBe(
      "Added 1 field, Modified 1 field, Removed 1 field"
    );
  });
});
