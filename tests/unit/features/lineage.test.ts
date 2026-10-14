import { describe, it, expect } from "vitest";
import {
  buildNodesAndEdges,
  applyDagreLayout,
  filterByDomain,
  getUniqueDomains,
  cardinalityLabel,
  TENANT_LEVEL_FILTER_KEY,
  type EntityData,
} from "@/features/lineage/useLineageLayout";

function makeEntity(overrides: Partial<EntityData> = {}): EntityData {
  return {
    id: "entity-1",
    name: "User",
    slug: "user",
    domainName: "Identity",
    domainSlug: "identity",
    productSlug: "core",
    status: "ACTIVE",
    fieldCount: 5,
    piiCount: 2,
    sensitiveCount: 1,
    description: "A user entity",
    fields: [
      { name: "id", type: "string" },
      { name: "email", type: "string", classification: "PII" },
    ],
    relationships: [],
    ...overrides,
  };
}

describe("Lineage Layout Utilities", () => {
  describe("cardinalityLabel", () => {
    it("maps one-to-one to 1:1", () => {
      expect(cardinalityLabel("one-to-one")).toBe("1:1");
    });

    it("maps one-to-many to 1:N", () => {
      expect(cardinalityLabel("one-to-many")).toBe("1:N");
    });

    it("maps many-to-one to N:1", () => {
      expect(cardinalityLabel("many-to-one")).toBe("N:1");
    });

    it("maps many-to-many to N:M", () => {
      expect(cardinalityLabel("many-to-many")).toBe("N:M");
    });

    it("returns unknown types as-is", () => {
      expect(cardinalityLabel("custom")).toBe("custom");
    });
  });

  describe("buildNodesAndEdges", () => {
    it("creates nodes only for entities participating in relationships", () => {
      const entities: EntityData[] = [
        makeEntity({
          id: "e1",
          name: "User",
          relationships: [{ targetEntityId: "e2", type: "one-to-many" }],
        }),
        makeEntity({ id: "e2", name: "Order", relationships: [] }),
        makeEntity({ id: "e3", name: "Orphan", relationships: [] }),
      ];

      const { nodes } = buildNodesAndEdges(entities);
      const nodeIds = nodes.map((n) => n.id);

      expect(nodeIds).toContain("e1");
      expect(nodeIds).toContain("e2");
      expect(nodeIds).not.toContain("e3");
    });

    it("creates edges with correct source, target, and cardinality label", () => {
      const entities: EntityData[] = [
        makeEntity({
          id: "e1",
          name: "User",
          relationships: [{ targetEntityId: "e2", type: "one-to-many" }],
        }),
        makeEntity({ id: "e2", name: "Order", relationships: [] }),
      ];

      const { edges } = buildNodesAndEdges(entities);

      expect(edges).toHaveLength(1);
      expect(edges[0].source).toBe("e1");
      expect(edges[0].target).toBe("e2");
      expect(edges[0].label).toBe("1:N");
    });

    it("creates edges for multiple relationships from same entity", () => {
      const entities: EntityData[] = [
        makeEntity({
          id: "e1",
          name: "User",
          relationships: [
            { targetEntityId: "e2", type: "one-to-many" },
            { targetEntityId: "e3", type: "one-to-one" },
          ],
        }),
        makeEntity({ id: "e2", name: "Order", relationships: [] }),
        makeEntity({ id: "e3", name: "Profile", relationships: [] }),
      ];

      const { edges } = buildNodesAndEdges(entities);

      expect(edges).toHaveLength(2);
      expect(edges[0].label).toBe("1:N");
      expect(edges[1].label).toBe("1:1");
    });

    it("uses muted color for edges involving deprecated entities", () => {
      const entities: EntityData[] = [
        makeEntity({
          id: "e1",
          name: "User",
          status: "DEPRECATED",
          relationships: [{ targetEntityId: "e2", type: "one-to-one" }],
        }),
        makeEntity({ id: "e2", name: "Order", relationships: [] }),
      ];

      const { edges } = buildNodesAndEdges(entities);

      expect(edges[0].style?.stroke).toBe("#8a8694");
      expect(edges[0].animated).toBe(false);
    });

    it("uses primary color for edges between active entities", () => {
      const entities: EntityData[] = [
        makeEntity({
          id: "e1",
          name: "User",
          status: "ACTIVE",
          relationships: [{ targetEntityId: "e2", type: "one-to-one" }],
        }),
        makeEntity({ id: "e2", name: "Order", status: "ACTIVE", relationships: [] }),
      ];

      const { edges } = buildNodesAndEdges(entities);

      expect(edges[0].style?.stroke).toBe("#A477B2");
      expect(edges[0].animated).toBe(true);
    });

    it("skips edges where target entity does not exist", () => {
      const entities: EntityData[] = [
        makeEntity({
          id: "e1",
          name: "User",
          relationships: [{ targetEntityId: "nonexistent", type: "one-to-one" }],
        }),
      ];

      const { edges } = buildNodesAndEdges(entities);
      expect(edges).toHaveLength(0);
    });

    it("node data includes entity info (name, fields, classification counts)", () => {
      const entities: EntityData[] = [
        makeEntity({
          id: "e1",
          name: "User",
          fieldCount: 5,
          piiCount: 2,
          sensitiveCount: 1,
          relationships: [{ targetEntityId: "e2", type: "one-to-one" }],
        }),
        makeEntity({ id: "e2", name: "Order", relationships: [] }),
      ];

      const { nodes } = buildNodesAndEdges(entities);
      const userNode = nodes.find((n) => n.id === "e1");

      expect(userNode).toBeDefined();
      expect(userNode!.data.label).toBe("User");
      expect(userNode!.data.fieldCount).toBe(5);
      expect(userNode!.data.piiCount).toBe(2);
      expect(userNode!.data.sensitiveCount).toBe(1);
    });

    it("returns empty arrays when no entities have relationships", () => {
      const entities: EntityData[] = [
        makeEntity({ id: "e1", relationships: [] }),
        makeEntity({ id: "e2", relationships: [] }),
      ];

      const { nodes, edges } = buildNodesAndEdges(entities);

      expect(nodes).toHaveLength(0);
      expect(edges).toHaveLength(0);
    });
  });

  describe("applyDagreLayout", () => {
    it("assigns valid x,y positions to all nodes", () => {
      const entities: EntityData[] = [
        makeEntity({
          id: "e1",
          relationships: [{ targetEntityId: "e2", type: "one-to-many" }],
        }),
        makeEntity({ id: "e2", relationships: [] }),
      ];

      const { nodes, edges } = buildNodesAndEdges(entities);
      const { nodes: layouted } = applyDagreLayout(nodes, edges);

      for (const node of layouted) {
        expect(typeof node.position.x).toBe("number");
        expect(typeof node.position.y).toBe("number");
        expect(Number.isFinite(node.position.x)).toBe(true);
        expect(Number.isFinite(node.position.y)).toBe(true);
      }
    });

    it("places source entities above target entities (TB layout)", () => {
      const entities: EntityData[] = [
        makeEntity({
          id: "e1",
          name: "Parent",
          relationships: [{ targetEntityId: "e2", type: "one-to-many" }],
        }),
        makeEntity({ id: "e2", name: "Child", relationships: [] }),
      ];

      const { nodes, edges } = buildNodesAndEdges(entities);
      const { nodes: layouted } = applyDagreLayout(nodes, edges);

      const parent = layouted.find((n) => n.id === "e1")!;
      const child = layouted.find((n) => n.id === "e2")!;

      expect(parent.position.y).toBeLessThan(child.position.y);
    });

    it("handles empty nodes array", () => {
      const { nodes, edges } = applyDagreLayout([], []);
      expect(nodes).toHaveLength(0);
      expect(edges).toHaveLength(0);
    });
  });

  describe("filterByDomain", () => {
    const entities: EntityData[] = [
      makeEntity({ id: "e1", domainSlug: "identity" }),
      makeEntity({ id: "e2", domainSlug: "payments" }),
      makeEntity({ id: "e3", domainSlug: "identity" }),
    ];

    it("returns all entities when domain is 'all'", () => {
      expect(filterByDomain(entities, "all")).toHaveLength(3);
    });

    it("returns all entities when domain is empty string", () => {
      expect(filterByDomain(entities, "")).toHaveLength(3);
    });

    it("filters entities to selected domain only", () => {
      const result = filterByDomain(entities, "identity");
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.domainSlug === "identity")).toBe(true);
    });

    it("returns empty array for non-existent domain", () => {
      expect(filterByDomain(entities, "nonexistent")).toHaveLength(0);
    });

    it("filters tenant-level entities (null domainSlug) by the tenant filter key", () => {
      const withTenant = [
        ...entities,
        makeEntity({ id: "e4", domainSlug: null, productSlug: null, domainName: "Enterprise" }),
      ];
      const result = filterByDomain(withTenant, TENANT_LEVEL_FILTER_KEY);
      expect(result.map((e) => e.id)).toEqual(["e4"]);
      expect(filterByDomain(withTenant, "identity")).toHaveLength(2);
    });
  });

  describe("getUniqueDomains", () => {
    it("extracts unique domains sorted by name", () => {
      const entities: EntityData[] = [
        makeEntity({ domainSlug: "payments", domainName: "Payments" }),
        makeEntity({ domainSlug: "identity", domainName: "Identity" }),
        makeEntity({ domainSlug: "identity", domainName: "Identity" }),
      ];

      const domains = getUniqueDomains(entities);

      expect(domains).toHaveLength(2);
      expect(domains[0]).toEqual({ slug: "identity", name: "Identity" });
      expect(domains[1]).toEqual({ slug: "payments", name: "Payments" });
    });

    it("lists tenant-level entities (null domainSlug) once under the tenant filter key", () => {
      const domains = getUniqueDomains([
        makeEntity({ domainSlug: null, productSlug: null, domainName: "Enterprise" }),
        makeEntity({ domainSlug: null, productSlug: null, domainName: "Enterprise" }),
        makeEntity({ domainSlug: "payments", domainName: "Payments" }),
      ]);

      expect(domains).toEqual([
        { slug: TENANT_LEVEL_FILTER_KEY, name: "Enterprise" },
        { slug: "payments", name: "Payments" },
      ]);
    });

    it("returns empty array for no entities", () => {
      expect(getUniqueDomains([])).toHaveLength(0);
    });
  });
});
