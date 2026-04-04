import { describe, it, expect } from "vitest";
import { computeDiffResult } from "@/lib/diff/field-diff";
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

describe("computeDiffResult", () => {
  it("returns empty diff when both snapshots are identical", () => {
    const fields = [makeField()];
    const result = computeDiffResult(fields, fields, 1, 2);

    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);
    expect(result.summary.added).toBe(0);
    expect(result.summary.removed).toBe(0);
    expect(result.summary.modified).toBe(0);
    expect(result.summary.unchanged).toBe(1);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].changeType).toBe("unchanged");
  });

  it("returns empty fields list when both snapshots are empty", () => {
    const result = computeDiffResult([], [], 1, 2);
    expect(result.summary).toEqual({ added: 0, removed: 0, modified: 0, unchanged: 0 });
    expect(result.fields).toHaveLength(0);
  });

  it("correctly identifies added fields (in B but not A)", () => {
    const versionA: FieldSnapshot[] = [];
    const versionB = [makeField({ name: "email", type: "string" })];

    const result = computeDiffResult(versionA, versionB, 1, 2);

    expect(result.summary.added).toBe(1);
    expect(result.summary.removed).toBe(0);
    expect(result.summary.modified).toBe(0);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].changeType).toBe("added");
    expect(result.fields[0].fieldName).toBe("email");
    expect(result.fields[0].versionA).toBeUndefined();
    expect(result.fields[0].versionB).toBeDefined();
  });

  it("correctly identifies removed fields (in A but not B)", () => {
    const versionA = [makeField({ name: "old_field" })];
    const versionB: FieldSnapshot[] = [];

    const result = computeDiffResult(versionA, versionB, 1, 2);

    expect(result.summary.removed).toBe(1);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].changeType).toBe("removed");
    expect(result.fields[0].fieldName).toBe("old_field");
    expect(result.fields[0].versionA).toBeDefined();
    expect(result.fields[0].versionB).toBeUndefined();
  });

  it("correctly identifies modified fields with property-level changes", () => {
    const versionA = [makeField({ name: "email", type: "string", classification: "PUBLIC" })];
    const versionB = [makeField({ name: "email", type: "integer", classification: "PII" })];

    const result = computeDiffResult(versionA, versionB, 1, 2);

    expect(result.summary.modified).toBe(1);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].changeType).toBe("modified");
    expect(result.fields[0].changedProperties).toBeDefined();
    expect(result.fields[0].changedProperties!.length).toBeGreaterThanOrEqual(2);

    const typeChange = result.fields[0].changedProperties!.find(
      (p) => p.property === "type"
    );
    expect(typeChange).toBeDefined();
    expect(typeChange!.before).toBe("string");
    expect(typeChange!.after).toBe("integer");

    const classChange = result.fields[0].changedProperties!.find(
      (p) => p.property === "classification"
    );
    expect(classChange).toBeDefined();
    expect(classChange!.before).toBe("PUBLIC");
    expect(classChange!.after).toBe("PII");
    expect(classChange!.category).toBe("governance");
  });

  it("captures decorator property changes with category 'decorators'", () => {
    const versionA = [
      makeField({
        name: "email",
        decorators: { validation: { format: "email" } },
      }),
    ];
    const versionB = [
      makeField({
        name: "email",
        decorators: { validation: { format: "uri" } },
      }),
    ];

    const result = computeDiffResult(versionA, versionB, 1, 2);

    expect(result.summary.modified).toBe(1);
    const decChange = result.fields[0].changedProperties!.find(
      (p) => p.property === "decorators"
    );
    expect(decChange).toBeDefined();
    expect(decChange!.category).toBe("decorators");
  });

  it("comparing identical versions returns 0 for all change counts", () => {
    const fields = [
      makeField({ name: "id", type: "string" }),
      makeField({ name: "name", type: "string", id: "f2" }),
    ];
    const result = computeDiffResult(fields, [...fields], 3, 3);

    expect(result.summary.added).toBe(0);
    expect(result.summary.removed).toBe(0);
    expect(result.summary.modified).toBe(0);
    expect(result.summary.unchanged).toBe(2);
  });

  it("comparing non-adjacent versions (e.g., v1 vs v5) works correctly", () => {
    // v1 has 3 fields
    const v1Fields = [
      makeField({ name: "id", type: "string", id: "f1" }),
      makeField({ name: "name", type: "string", id: "f2" }),
      makeField({ name: "deprecated_field", type: "integer", id: "f3" }),
    ];

    // v5 has different fields (simulating many changes over time)
    const v5Fields = [
      makeField({ name: "id", type: "uuid", id: "f1" }),  // type changed
      makeField({ name: "name", type: "string", id: "f2" }),  // unchanged
      makeField({ name: "email", type: "string", id: "f4" }),  // added
      makeField({ name: "status", type: "string", id: "f5" }),  // added
    ];

    const result = computeDiffResult(v1Fields, v5Fields, 1, 5);

    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(5);
    expect(result.summary.added).toBe(2);       // email, status
    expect(result.summary.removed).toBe(1);      // deprecated_field
    expect(result.summary.modified).toBe(1);     // id (type changed)
    expect(result.summary.unchanged).toBe(1);    // name
  });

  it("handles mixed added, removed, modified, and unchanged simultaneously", () => {
    const versionA = [
      makeField({ name: "keep_same", type: "string", id: "f1" }),
      makeField({ name: "will_modify", type: "string", id: "f2" }),
      makeField({ name: "will_remove", type: "integer", id: "f3" }),
    ];
    const versionB = [
      makeField({ name: "keep_same", type: "string", id: "f1" }),
      makeField({ name: "will_modify", type: "integer", id: "f2" }),
      makeField({ name: "newly_added", type: "boolean", id: "f4" }),
    ];

    const result = computeDiffResult(versionA, versionB, 1, 2);

    expect(result.summary.added).toBe(1);
    expect(result.summary.removed).toBe(1);
    expect(result.summary.modified).toBe(1);
    expect(result.summary.unchanged).toBe(1);
    expect(result.fields).toHaveLength(4);
  });

  it("sorts fields: added, modified, removed, unchanged", () => {
    const versionA = [
      makeField({ name: "unchanged", type: "string", id: "f1" }),
      makeField({ name: "modified", type: "string", id: "f2" }),
      makeField({ name: "removed", type: "integer", id: "f3" }),
    ];
    const versionB = [
      makeField({ name: "unchanged", type: "string", id: "f1" }),
      makeField({ name: "modified", type: "integer", id: "f2" }),
      makeField({ name: "added", type: "boolean", id: "f4" }),
    ];

    const result = computeDiffResult(versionA, versionB, 1, 2);

    expect(result.fields[0].changeType).toBe("added");
    expect(result.fields[1].changeType).toBe("modified");
    expect(result.fields[2].changeType).toBe("removed");
    expect(result.fields[3].changeType).toBe("unchanged");
  });

  it("provides versionA and versionB snapshots for modified fields", () => {
    const versionA = [makeField({ name: "email", nullable: true })];
    const versionB = [makeField({ name: "email", nullable: false })];

    const result = computeDiffResult(versionA, versionB, 1, 2);

    expect(result.fields[0].versionA).toBeDefined();
    expect(result.fields[0].versionB).toBeDefined();
    expect(result.fields[0].versionA!.nullable).toBe(true);
    expect(result.fields[0].versionB!.nullable).toBe(false);
  });

  it("alias changes have category 'metadata'", () => {
    const versionA = [makeField({ name: "email", aliases: ["e-mail"] })];
    const versionB = [makeField({ name: "email", aliases: ["e-mail", "email_addr"] })];

    const result = computeDiffResult(versionA, versionB, 1, 2);

    const aliasChange = result.fields[0].changedProperties!.find(
      (p) => p.property === "aliases"
    );
    expect(aliasChange).toBeDefined();
    expect(aliasChange!.category).toBe("metadata");
  });
});
