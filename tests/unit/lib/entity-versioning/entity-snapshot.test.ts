import { describe, it, expect } from "vitest";
import { entitySnapshotReport, readEntitySnapshot, withoutSchemaVersions } from "@/lib/entity-versioning/entity-snapshot";

// FINAL WAVE 2b, G7: the entity's own content, as a publish freezes it in the version's compatReport JSON (no column).
describe("entitySnapshotReport / readEntitySnapshot", () => {
  const entity = { name: "Order", description: "An order", status: "ACTIVE", metadata: { tags: ["a"], retentionPolicy: { period: 7 }, schemaVersions: { avro: ["big"] } } };

  it("freezes name, description, status and the metadata without its stored schema versions, and reads it back", () => {
    const report = entitySnapshotReport(entity);
    expect(report).toEqual({ entitySnapshot: { name: "Order", description: "An order", status: "ACTIVE", metadata: { tags: ["a"], retentionPolicy: { period: 7 } } } });
    expect(readEntitySnapshot(JSON.parse(JSON.stringify(report)))).toEqual(report.entitySnapshot);
  });

  it("does not modify the entity, and keeps a null metadata as null", () => {
    const copy = JSON.parse(JSON.stringify(entity));
    entitySnapshotReport(entity);
    expect(entity).toEqual(copy);
    expect(entitySnapshotReport({ ...entity, metadata: null }).entitySnapshot.metadata).toBeNull();
  });

  it.each([[null], [undefined], ["x"], [3], [[]], [{}], [{ entitySnapshot: null }], [{ entitySnapshot: [] }],
    [{ entitySnapshot: { description: "", status: "A", metadata: {} } }],
    [{ entitySnapshot: { name: "N", status: "A", metadata: {} } }],
    [{ entitySnapshot: { name: "N", description: "", metadata: {} } }]])("reads %j as no snapshot (a version published before snapshots)", (compatReport) => {
    expect(readEntitySnapshot(compatReport)).toBeUndefined();
  });

  it("reads a snapshot without metadata as null metadata, and leaves a prototype key alone", () => {
    expect(readEntitySnapshot({ entitySnapshot: { name: "N", description: "", status: "A" } })).toEqual({ name: "N", description: "", status: "A", metadata: null });
    expect(readEntitySnapshot(JSON.parse('{"__proto__": {"entitySnapshot": {"name": "N", "description": "", "status": "A"}}}'))).toBeUndefined();
  });
});

describe("withoutSchemaVersions", () => {
  it("drops only schemaVersions, passes anything that is not a plain object through, and does not mutate", () => {
    const metadata = { tags: ["a"], schemaVersions: { avro: [] } };
    expect(withoutSchemaVersions(metadata)).toEqual({ tags: ["a"] });
    expect(metadata).toHaveProperty("schemaVersions");
    for (const other of [null, undefined, "x", 3, []]) expect(withoutSchemaVersions(other)).toBe(other);
    const plain = { tags: [] };
    expect(withoutSchemaVersions(plain)).toBe(plain);
  });
});
