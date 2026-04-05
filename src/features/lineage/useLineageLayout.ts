import Dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

export interface EntityData {
  id: string;
  name: string;
  slug: string;
  domainName: string;
  domainSlug: string;
  status: string;
  fieldCount: number;
  piiCount?: number;
  sensitiveCount?: number;
  description?: string;
  fields?: { name: string; type: string; classification?: string }[];
  relationships: { targetEntityId: string; type: string }[];
}

const NODE_WIDTH = 200;
const NODE_HEIGHT = 120;

/** Map relationship type enum to cardinality label */
export function cardinalityLabel(type: string): string {
  switch (type) {
    case "one-to-one":
      return "1:1";
    case "one-to-many":
      return "1:N";
    case "many-to-one":
      return "N:1";
    case "many-to-many":
      return "N:M";
    default:
      return type;
  }
}

/** Build React Flow nodes and edges from entity data */
export function buildNodesAndEdges(entities: EntityData[]): {
  nodes: Node[];
  edges: Edge[];
} {
  // Collect IDs of entities that participate in relationships
  const participatingIds = new Set<string>();
  for (const entity of entities) {
    for (const rel of entity.relationships) {
      participatingIds.add(entity.id);
      participatingIds.add(rel.targetEntityId);
    }
  }

  // Only include entities that participate in relationships
  const entityMap = new Map(entities.map((e) => [e.id, e]));

  const nodes: Node[] = entities
    .filter((e) => participatingIds.has(e.id))
    .map((entity) => ({
      id: entity.id,
      type: "entity",
      position: { x: 0, y: 0 }, // will be set by dagre
      data: {
        label: entity.name,
        slug: entity.slug,
        domainName: entity.domainName,
        domainSlug: entity.domainSlug,
        status: entity.status,
        fieldCount: entity.fieldCount,
        piiCount: entity.piiCount ?? 0,
        sensitiveCount: entity.sensitiveCount ?? 0,
        description: entity.description ?? "",
        fields: entity.fields ?? [],
      },
    }));

  const edges: Edge[] = [];
  for (const entity of entities) {
    for (const rel of entity.relationships) {
      // Only add edge if both source and target exist in the entity set
      if (!entityMap.has(entity.id) || !entityMap.has(rel.targetEntityId))
        continue;

      const sourceStatus = entity.status;
      const targetEntity = entityMap.get(rel.targetEntityId);
      const targetStatus = targetEntity?.status;
      const isDeprecated =
        sourceStatus === "DEPRECATED" || targetStatus === "DEPRECATED";

      edges.push({
        id: `${entity.id}-${rel.targetEntityId}`,
        source: entity.id,
        target: rel.targetEntityId,
        label: cardinalityLabel(rel.type),
        type: "smoothstep",
        animated: !isDeprecated,
        style: {
          stroke: isDeprecated ? "#8a8694" : "#A477B2",
          strokeWidth: 2,
        },
        labelStyle: {
          fontSize: 11,
          fontWeight: 500,
          fill: isDeprecated ? "#8a8694" : "#c4c4cc",
        },
        labelBgStyle: {
          fill: "#1c1c26",
          fillOpacity: 0.9,
        },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: {
          type: "arrowclosed" as const,
          color: isDeprecated ? "#8a8694" : "#A477B2",
        },
      });
    }
  }

  return { nodes, edges };
}

/** Apply dagre layout to nodes and edges. Returns new arrays with position set. */
export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[]
): { nodes: Node[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes, edges };

  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 100, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  Dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

/** Filter entities by domain. "all" or empty means no filter. */
export function filterByDomain(
  entities: EntityData[],
  domain: string
): EntityData[] {
  if (!domain || domain === "all") return entities;
  return entities.filter((e) => e.domainSlug === domain);
}

/** Extract unique domains from entity list */
export function getUniqueDomains(
  entities: EntityData[]
): { slug: string; name: string }[] {
  const map = new Map<string, string>();
  for (const e of entities) {
    if (!map.has(e.domainSlug)) {
      map.set(e.domainSlug, e.domainName);
    }
  }
  return Array.from(map.entries())
    .map(([slug, name]) => ({ slug, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
