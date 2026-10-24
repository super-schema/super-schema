import { describe, expect, it } from "vitest";
import { entityRelationships } from "@/lib/lineage/entity-relationships";

// The Lineage Graph draws an edge for each entity relationship. A user makes one by adding a reference field (`type: "reference"`, or an
// array / map of references) whose decorators carry `referencedEntityId`; nothing writes `metadata.relationships`, which the page used to
// read alone, so every reference a user made was missing from the graph.
const reference = (targetId: string, extra: Record<string, unknown> = {}) => ({ referencedEntityId: targetId, referencedEntityName: "Target", ...extra });

describe("entityRelationships", () => {
  it("a reference field is a many-to-one relationship to the entity it references", () => {
    expect(entityRelationships({ metadataRelationships: [], fields: [{ type: "reference", decorators: reference("ent-b") }] })).toEqual([
      { targetEntityId: "ent-b", type: "many-to-one" },
    ]);
  });

  it("an array of references is one-to-many, a map of references too", () => {
    expect(
      entityRelationships({
        metadataRelationships: [],
        fields: [
          { type: "array", decorators: reference("ent-b", { arrayElementType: "reference" }) },
          { type: "map", decorators: reference("ent-c", { mapValueType: "reference" }) },
        ],
      }),
    ).toEqual([
      { targetEntityId: "ent-b", type: "one-to-many" },
      { targetEntityId: "ent-c", type: "one-to-many" },
    ]);
  });

  it("keeps the relationships stored in the entity's metadata, and says each pair once", () => {
    expect(
      entityRelationships({
        metadataRelationships: [{ targetEntityId: "ent-b", cardinality: "one-to-one" }],
        fields: [
          { type: "reference", decorators: reference("ent-b") },
          { type: "reference", decorators: reference("ent-b") },
          { type: "reference", decorators: reference("ent-d") },
        ],
      }),
    ).toEqual([
      { targetEntityId: "ent-b", type: "one-to-one" },
      { targetEntityId: "ent-d", type: "many-to-one" },
    ]);
  });

  it("a field that is not a reference any more, with reference keys left in its decorators, draws nothing", () => {
    expect(entityRelationships({ metadataRelationships: [], fields: [{ type: "string", decorators: reference("ent-b") }] })).toEqual([]);
    expect(entityRelationships({ metadataRelationships: [], fields: [{ type: "array", decorators: reference("ent-b", { arrayElementType: "string" }) }] })).toEqual([]);
  });

  it("a reference to a name only (it has no entity id yet) draws nothing: there is no node to point at", () => {
    expect(entityRelationships({ metadataRelationships: [], fields: [{ type: "reference", decorators: { referencedEntityName: "Customer" } }] })).toEqual([]);
  });

  it("fields with no decorators are skipped", () => {
    expect(entityRelationships({ metadataRelationships: [], fields: [{ type: "reference", decorators: null }, { type: "string", decorators: {} }] })).toEqual([]);
  });
});
