import { describe, it, expect } from "vitest";
import { collectReferencedEntityIds } from "@/lib/entity-versioning/reference-targets";

describe("collectReferencedEntityIds", () => {
  it("collects decorators.referencedEntityId from reference fields", () => {
    const fields = [
      { id: "f1", decorators: { referencedEntityId: "customer", referencedEntityName: "Customer" } },
      { id: "f2", decorators: {} },
    ];
    expect(collectReferencedEntityIds("order", fields, null)).toEqual(["customer"]);
  });

  it("collects metadata relationships whose field still exists", () => {
    const meta = {
      relationships: [
        { targetEntityId: "address", fieldId: "f1", cardinality: "many-to-one" },
        { targetEntityId: "stale", fieldId: "gone", cardinality: "many-to-one" },
      ],
    };
    expect(collectReferencedEntityIds("order", [{ id: "f1", decorators: {} }], meta)).toEqual(["address"]);
  });

  it("dedupes, drops self references and blanks, and sorts", () => {
    const fields = [
      { id: "f1", decorators: { referencedEntityId: "zeta" } },
      { id: "f2", decorators: { referencedEntityId: "alpha" } },
      { id: "f3", decorators: { referencedEntityId: "order" } },
      { id: "f4", decorators: { referencedEntityId: "  " } },
      { id: "f5", decorators: { referencedEntityId: 42 } },
    ];
    const meta = { relationships: [{ targetEntityId: "alpha", fieldId: "f2", cardinality: "many-to-one" }] };
    expect(collectReferencedEntityIds("order", fields, meta)).toEqual(["alpha", "zeta"]);
  });

  it("tolerates malformed metadata and decorators", () => {
    expect(collectReferencedEntityIds("order", [{ id: "f1", decorators: null }], { relationships: "nope" })).toEqual([]);
  });
});
