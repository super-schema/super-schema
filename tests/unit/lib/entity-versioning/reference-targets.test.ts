import { describe, it, expect } from "vitest";
import {
  collectReferencedEntityIds,
  collectReferencedEntityNames,
  resolveReferencedEntityNames,
} from "@/lib/entity-versioning/reference-targets";

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

  it("ignores the stale reference keys of a field that is no longer a reference (when it says its type)", () => {
    const stale = { referencedEntityId: "old-target", referencedEntityVersion: "9.9" };
    const fields = [
      { id: "f1", type: "string", decorators: stale },
      { id: "f2", type: "array", decorators: { arrayElementType: "string", ...stale } },
      { id: "f3", type: "reference", decorators: { referencedEntityId: "customer" } },
      { id: "f4", type: "array", decorators: { arrayElementType: "reference", referencedEntityId: "address" } },
      { id: "f5", type: "map", decorators: { mapValueType: "reference", referencedEntityId: "money" } },
    ];
    expect(collectReferencedEntityIds("order", fields, null)).toEqual(["address", "customer", "money"]);
  });

  it("a field that does not say its type counts as before", () => {
    expect(collectReferencedEntityIds("order", [{ id: "f1", decorators: { referencedEntityId: "x" } }], null)).toEqual(["x"]);
  });
});

describe("collectReferencedEntityNames", () => {
  it("ignores a stale name on a field that is no longer a reference", () => {
    const fields = [
      { id: "f1", type: "string", decorators: { referencedEntityName: "Gone" } },
      { id: "f2", type: "reference", decorators: { referencedEntityName: "Customer" } },
      { id: "f3", type: "map", decorators: { mapValueType: "reference", referencedEntityName: "Money" } },
    ];
    expect(collectReferencedEntityNames(fields)).toEqual(["Customer", "Money"]);
  });

  it("returns names only for references that carry no entity id", () => {
    const fields = [
      { id: "f1", decorators: { referencedEntityName: "Customer" } },
      { id: "f2", decorators: { referencedEntityId: "addr", referencedEntityName: "Address" } },
      { id: "f3", decorators: { arrayElementType: "reference", referencedEntityName: " LineItem " } },
      { id: "f4", decorators: { referencedEntityName: "customer" } },
      { id: "f5", decorators: { referencedEntityName: "" } },
      { id: "f6", decorators: null },
    ];
    // trimmed, case-insensitively deduped (first spelling wins), sorted
    expect(collectReferencedEntityNames(fields)).toEqual(["Customer", "LineItem"]);
  });
});

describe("resolveReferencedEntityNames", () => {
  const owner = { id: "order", name: "Order", tenantId: "t1", domainId: "d1", productId: "p1" };
  const cand = (id: string, name: string, domainId: string | null, productId: string | null, tenantId = "t1") => ({
    id, name, tenantId, domainId, productId,
  });

  it("resolves case-insensitively against tenant, domain and own-product entities", () => {
    const candidates = [
      cand("cust", "Customer", "d1", "p1"),
      cand("money", "Money", null, null),
      cand("region", "Region", "d1", null),
    ];
    expect(resolveReferencedEntityNames(owner, ["customer", "Money", "REGION"], candidates)).toEqual({
      entityIds: ["cust", "money", "region"],
      unresolvedNames: [],
    });
  });

  it("matches the sanitized TypeSpec identifier of an entity name", () => {
    const candidates = [cand("li", "Line Item", "d1", "p1")];
    expect(resolveReferencedEntityNames(owner, ["Line_Item"], candidates)).toEqual({
      entityIds: ["li"],
      unresolvedNames: [],
    });
  });

  it("ignores entities outside the line (sibling product, other domain, other tenant)", () => {
    const candidates = [
      cand("sib", "Customer", "d1", "p2"),
      cand("other-domain", "Customer", "d2", null),
      cand("other-tenant", "Customer", null, null, "t2"),
    ];
    expect(resolveReferencedEntityNames(owner, ["Customer"], candidates)).toEqual({
      entityIds: [],
      unresolvedNames: ["Customer"],
    });
  });

  it("drops self references without warning", () => {
    const candidates = [cand("order", "Order", "d1", "p1")];
    expect(resolveReferencedEntityNames(owner, ["Order"], candidates)).toEqual({
      entityIds: [],
      unresolvedNames: [],
    });
  });
});
