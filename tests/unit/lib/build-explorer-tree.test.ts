import { describe, it, expect } from "vitest";
import { buildExplorerTree } from "@/lib/navigation/build-explorer-tree";

describe("buildExplorerTree", () => {
  it("places rows at the right level and counts per level", () => {
    const tree = buildExplorerTree({
      domains: [{ id: "d1", name: "Payments", slug: "payments", isSystem: false }],
      products: [{ id: "p1", domainId: "d1", name: "Checkout", slug: "checkout", isSystem: false }],
      entities: [
        { id: "e0", name: "Customer", slug: "customer", status: "ACTIVE", domainId: null, productId: null },
        { id: "e1", name: "Order", slug: "order", status: "DRAFT", domainId: "d1", productId: "p1" },
      ],
      dataTypes: [
        { domainId: null, productId: null },
        { domainId: "d1", productId: null },
        { domainId: "d1", productId: "p1" },
        { domainId: "d1", productId: "p1" },
      ],
      services: [{ domainId: "d1", productId: null }],
    });
    expect(tree.enterprise.counts).toEqual({ dataTypes: 1, entities: 1, traits: 0 });
    expect(tree.enterprise.entities.map((e) => e.slug)).toEqual(["customer"]);
    expect(tree.domains[0].counts).toEqual({ dataTypes: 1, apis: 1, traits: 0 });
    expect(tree.domains[0].products[0].counts).toMatchObject({ dataTypes: 2, apis: 0, entities: 1 });
    expect(tree.domains[0].products[0].entities.map((e) => e.slug)).toEqual(["order"]);
  });
});
