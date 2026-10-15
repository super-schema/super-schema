import { describe, it, expect } from "vitest";
import { buildExplorerTree } from "@/lib/navigation/build-explorer-tree";

const domains = [{ id: "d1", name: "Payments", slug: "payments", isSystem: false }];
const products = [{ id: "p1", domainId: "d1", name: "Checkout", slug: "checkout", isSystem: false }];

describe("buildExplorerTree — events counts", () => {
  it("counts traits at every level and messages / channels / event specs per product", () => {
    const tree = buildExplorerTree({
      domains,
      products,
      entities: [],
      dataTypes: [],
      services: [],
      traits: [{ domainId: null, productId: null }, { domainId: "d1", productId: null }, { domainId: "d1", productId: "p1" }],
      messages: [{ domainId: "d1", productId: "p1" }, { domainId: "d1", productId: "p1" }],
      channels: [{ domainId: "d1", productId: "p1" }],
      eventSpecs: [],
    });
    expect(tree.enterprise.counts.traits).toBe(1);
    expect(tree.domains[0].counts.traits).toBe(1);
    expect(tree.domains[0].products[0].counts).toMatchObject({ traits: 1, messages: 2, channels: 1, eventSpecs: 0 });
  });

  it("sums pre-aggregated rows (Prisma groupBy) by their count", () => {
    const tree = buildExplorerTree({
      domains,
      products,
      entities: [],
      dataTypes: [],
      services: [],
      traits: [{ domainId: null, productId: null, count: 4 }, { domainId: "d1", productId: null, count: 2 }],
      messages: [{ domainId: "d1", productId: "p1", count: 5 }],
      channels: [{ domainId: "d1", productId: "p1", count: 0 }],
      eventSpecs: [{ domainId: "d1", productId: "p1", count: 3 }],
    });
    expect(tree.enterprise.counts.traits).toBe(4);
    expect(tree.domains[0].counts.traits).toBe(2);
    expect(tree.domains[0].products[0].counts).toMatchObject({ traits: 0, messages: 5, channels: 0, eventSpecs: 3 });
  });

  it("keeps working when the events inputs are omitted", () => {
    const tree = buildExplorerTree({ domains, products, entities: [], dataTypes: [], services: [] });
    expect(tree.enterprise.counts.traits).toBe(0);
    expect(tree.domains[0].products[0].counts).toMatchObject({ traits: 0, messages: 0, channels: 0, eventSpecs: 0 });
  });
});
