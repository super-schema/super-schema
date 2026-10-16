import { describe, it, expect } from "vitest";
import { buildExplorerTree } from "@/lib/navigation/build-explorer-tree";

const domains = [{ id: "d1", name: "Payments", slug: "payments", isSystem: false }];
const products = [{ id: "p1", domainId: "d1", name: "Checkout", slug: "checkout", isSystem: false }];

describe("buildExplorerTree — events counts", () => {
  it("counts traits at every level and events per product", () => {
    const tree = buildExplorerTree({
      domains,
      products,
      entities: [],
      dataTypes: [],
      services: [],
      traits: [{ domainId: null, productId: null }, { domainId: "d1", productId: null }, { domainId: "d1", productId: "p1" }],
      events: [{ domainId: "d1", productId: "p1" }, { domainId: "d1", productId: "p1" }],
    });
    expect(tree.enterprise.counts.traits).toBe(1);
    expect(tree.domains[0].counts.traits).toBe(1);
    expect(tree.domains[0].products[0].counts).toMatchObject({ traits: 1, events: 2 });
  });

  it("sums pre-aggregated rows (Prisma groupBy) by their count", () => {
    const tree = buildExplorerTree({
      domains,
      products,
      entities: [],
      dataTypes: [],
      services: [],
      traits: [{ domainId: null, productId: null, count: 4 }, { domainId: "d1", productId: null, count: 2 }],
      events: [{ domainId: "d1", productId: "p1", count: 3 }],
    });
    expect(tree.enterprise.counts.traits).toBe(4);
    expect(tree.domains[0].counts.traits).toBe(2);
    expect(tree.domains[0].products[0].counts).toMatchObject({ traits: 0, events: 3 });
  });

  it("keeps working when the events inputs are omitted", () => {
    const tree = buildExplorerTree({ domains, products, entities: [], dataTypes: [], services: [] });
    expect(tree.enterprise.counts.traits).toBe(0);
    expect(tree.domains[0].products[0].counts).toMatchObject({ traits: 0, events: 0 });
  });

  it("has no per-kind counts for the retired catalog model (messages, channels, event specs)", () => {
    const tree = buildExplorerTree({ domains, products, entities: [], dataTypes: [], services: [] });
    expect(Object.keys(tree.domains[0].products[0].counts).sort()).toEqual(["apis", "dataTypes", "entities", "events", "traits"]);
  });
});
