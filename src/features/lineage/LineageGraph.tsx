"use client";

import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { EntityNode } from "./EntityNode";

interface EntityData {
  id: string;
  name: string;
  domainName: string;
  domainSlug: string;
  status: string;
  fieldCount: number;
  relationships: { targetEntityId: string; type: string }[];
}

interface LineageGraphProps {
  entities: EntityData[];
}

const nodeTypes: NodeTypes = {
  entity: EntityNode,
};

export function LineageGraph({ entities }: LineageGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = entities.map((entity, i) => ({
      id: entity.id,
      type: "entity",
      position: {
        x: (i % 4) * 280 + 50,
        y: Math.floor(i / 4) * 180 + 50,
      },
      data: {
        label: entity.name,
        domainName: entity.domainName,
        domainSlug: entity.domainSlug,
        status: entity.status,
        fieldCount: entity.fieldCount,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    }));

    const edges: Edge[] = [];
    for (const entity of entities) {
      for (const rel of entity.relationships) {
        edges.push({
          id: `${entity.id}-${rel.targetEntityId}`,
          source: entity.id,
          target: rel.targetEntityId,
          label: rel.type,
          animated: true,
          style: { stroke: "#A477B2" },
        });
      }
    }

    return { nodes, edges };
  }, [entities]);

  if (entities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <h2 className="text-heading-1 text-foreground mb-space-2">
          No entity relationships yet
        </h2>
        <p className="text-body text-muted-foreground">
          Create entities and define relationships to see the lineage graph
        </p>
      </div>
    );
  }

  return (
    <div className="w-full h-full" style={{ minHeight: 500 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        className="bg-background"
      >
        <Background color="#333340" gap={32} size={1} />
        <Controls className="bg-card border border-border rounded-lg" />
      </ReactFlow>
    </div>
  );
}
