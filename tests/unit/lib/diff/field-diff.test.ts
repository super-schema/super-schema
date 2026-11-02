import { describe, it, expect } from "vitest";
import { computeDiffResult, computeFieldDiff, summarizeChanges } from "@/lib/diff/field-diff";
import type { FieldSnapshot } from "@/services/version-history/version.types";

/** The decorators a reference field stores once it points at an entity (see `writeFieldReference`). */
function referenceTo(entityId: string, entityName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    referencedEntityId: entityId,
    referencedEntityName: entityName,
    referencedQualifiedName: `Sales/Orders/${entityName}`,
    referencedDomain: "Sales",
    referencedProduct: "Orders",
    referencedEntity: entityName,
    ...extra,
  };
}

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

describe("re-pointing a reference", () => {
  const customer = (decorators: Record<string, unknown>) => makeField({ name: "customer", type: "reference", decorators });

  it("is one referenceTarget change, not a decorators edit, when the field points at another entity", () => {
    const changes = computeFieldDiff(
      [customer(referenceTo("cust-1", "Customer"))],
      [customer(referenceTo("vend-1", "Vendor"))]
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("modified");
    expect(changes[0].details.changedProperties).toEqual(["referenceTarget"]);
  });

  it("is a re-point when another entity has the same name (the ids differ)", () => {
    const changes = computeFieldDiff(
      [customer(referenceTo("cust-1", "Customer"))],
      [customer(referenceTo("cust-2", "Customer"))]
    );

    expect(changes[0].details.changedProperties).toEqual(["referenceTarget"]);
  });

  it("is not a re-point when a legacy name-only reference gains the id of the entity it already named", () => {
    const changes = computeFieldDiff(
      [customer({ referencedEntityName: "Customer" })],
      [customer(referenceTo("cust-1", "Customer"))]
    );

    expect(changes[0].details.changedProperties).toEqual(["decorators"]);
  });

  it("is a re-point when a reference that named its entity by id is left with the name only", () => {
    const before = customer(referenceTo("cust-1", "Customer"));
    const after = customer({ referencedEntityName: "Customer" });

    expect(computeFieldDiff([before], [after])[0].details.changedProperties).toEqual(["referenceTarget"]);
    const modified = computeDiffResult([before], [after], 1, 2).fields[0];
    expect(modified.changedProperties).toEqual([
      { property: "referenceTarget", category: "reference", before: "Sales / Orders / Customer", after: "Customer (by name)" },
    ]);
  });

  it("is a decorators edit, not a re-point, when only the version pin changes", () => {
    const changes = computeFieldDiff(
      [customer(referenceTo("cust-1", "Customer"))],
      [customer(referenceTo("cust-1", "Customer", { referencedEntityVersion: "2.1" }))]
    );

    expect(changes[0].details.changedProperties).toEqual(["decorators"]);
  });

  it("keeps the decorators change next to the re-point when other decorator keys changed too", () => {
    const changes = computeFieldDiff(
      [customer(referenceTo("cust-1", "Customer"))],
      [customer(referenceTo("vend-1", "Vendor", { validation: { required: true } }))]
    );

    expect(changes[0].details.changedProperties).toEqual(["decorators", "referenceTarget"]);
  });

  it("is not a re-point when the field stopped holding a reference (its type change is the change)", () => {
    const changes = computeFieldDiff(
      [customer(referenceTo("cust-1", "Customer"))],
      [makeField({ name: "customer", type: "string", decorators: {} })]
    );

    expect(changes[0].details.changedProperties).toContain("type");
    expect(changes[0].details.changedProperties).not.toContain("referenceTarget");
  });

  it("names the old and the new target in the diff result", () => {
    const result = computeDiffResult(
      [customer(referenceTo("cust-1", "Customer"))],
      [customer(referenceTo("vend-1", "Vendor"))],
      1,
      2
    );

    const modified = result.fields.find((f) => f.fieldName === "customer");
    expect(modified?.changeType).toBe("modified");
    expect(modified?.changedProperties).toEqual([
      { property: "referenceTarget", category: "reference", before: "Sales / Orders / Customer", after: "Sales / Orders / Vendor" },
    ]);
  });

  /** A reference that names its entity by qualified name only (no id), as a reference written before ids were stored. */
  const qualifiedNoId = (domain: string, product: string, entity = "Customer") => ({
    referencedQualifiedName: `${domain}/${product}/${entity}`,
    referencedDomain: domain,
    referencedProduct: product,
    referencedEntity: entity,
    referencedEntityName: entity,
  });

  it("is a re-point when a reference without an id moves to a same-named entity in another product", () => {
    const changes = computeFieldDiff(
      [customer(qualifiedNoId("Sales", "Orders"))],
      [customer(qualifiedNoId("Billing", "Core"))]
    );

    expect(changes[0].details.changedProperties).toEqual(["referenceTarget"]);
  });

  it("labels two same-named targets by their qualified names", () => {
    const modified = computeDiffResult(
      [customer(qualifiedNoId("Sales", "Orders"))],
      [customer(qualifiedNoId("Billing", "Core"))],
      1,
      2
    ).fields[0];

    expect(modified.changedProperties).toEqual([
      { property: "referenceTarget", category: "reference", before: "Sales / Orders / Customer", after: "Billing / Core / Customer" },
    ]);
  });

  it("is a re-point when an array of references moves to another entity, not a decorators edit", () => {
    const list = (decorators: Record<string, unknown>) =>
      makeField({ name: "customers", type: "array", decorators: { arrayElementType: "reference", ...decorators } });
    const changes = computeFieldDiff(
      [list(referenceTo("cust-1", "Customer"))],
      [list(referenceTo("vend-1", "Vendor"))]
    );

    expect(changes[0].details.changedProperties).toEqual(["referenceTarget"]);
  });

  it("is a re-point when a map of references moves to another entity, not a decorators edit", () => {
    const map = (decorators: Record<string, unknown>) =>
      makeField({ name: "customers", type: "map", decorators: { mapValueType: "reference", ...decorators } });
    const changes = computeFieldDiff(
      [map(referenceTo("cust-1", "Customer"))],
      [map(referenceTo("vend-1", "Vendor"))]
    );

    expect(changes[0].details.changedProperties).toEqual(["referenceTarget"]);
  });

  it("is a re-point when a name-only reference is renamed to another entity", () => {
    const changes = computeFieldDiff(
      [customer({ referencedEntityName: "Customer" })],
      [customer({ referencedEntityName: "Client" })]
    );

    expect(changes[0].details.changedProperties).toEqual(["referenceTarget"]);
  });

  it("accepts a legacy name-only reference that gains the id of a same-named entity in another product as the same target (known trade-off)", () => {
    // A name-only reference carries no product, so the upgrade cannot tell this apart from the entity it named. Pinned on purpose.
    const changes = computeFieldDiff(
      [customer({ referencedEntityName: "Customer" })],
      [customer({ ...qualifiedNoId("Billing", "Core"), referencedEntityId: "cust-9" })]
    );

    expect(changes[0].details.changedProperties).toEqual(["decorators"]);
  });
});

describe("element type of an array or a map", () => {
  it("is a type change when the element type of an array changes", () => {
    const changes = computeFieldDiff(
      [makeField({ name: "tags", type: "array", decorators: { arrayElementType: "string" } })],
      [makeField({ name: "tags", type: "array", decorators: { arrayElementType: "int" } })]
    );

    expect(changes[0].details.changedProperties).toContain("type");
  });

  it("is a type change when a string array becomes an array of references", () => {
    const changes = computeFieldDiff(
      [makeField({ name: "owners", type: "array", decorators: { arrayElementType: "string" } })],
      [makeField({ name: "owners", type: "array", decorators: { arrayElementType: "reference", ...referenceTo("cust-1", "Customer") } })]
    );

    expect(changes[0].details.changedProperties).toContain("type");
    expect(changes[0].details.changedProperties).not.toContain("referenceTarget");
  });

  it("is a type change when the value type of a map changes", () => {
    const changes = computeFieldDiff(
      [makeField({ name: "scores", type: "map", decorators: { mapValueType: "string" } })],
      [makeField({ name: "scores", type: "map", decorators: { mapValueType: "float" } })]
    );

    expect(changes[0].details.changedProperties).toContain("type");
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
