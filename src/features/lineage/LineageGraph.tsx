"use client";

import { useCallback, useMemo, useState, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  ReactFlowProvider,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { EntityNode } from "./EntityNode";
import {
  type EntityData,
  buildNodesAndEdges,
  applyDagreLayout,
  filterByDomain,
  getUniqueDomains,
} from "./useLineageLayout";
import { Maximize2 } from "lucide-react";

interface LineageGraphProps {
  entities: EntityData[];
}

const nodeTypes: NodeTypes = {
  entity: EntityNode,
};

const LARGE_NODE_THRESHOLD = 100;
const LARGE_EDGE_THRESHOLD = 200;

function LineageGraphInner({ entities }: LineageGraphProps) {
  const [selectedDomain, setSelectedDomain] = useState("all");
  const { fitView } = useReactFlow();
  const initialFitDone = useRef(false);

  const domains = useMemo(() => getUniqueDomains(entities), [entities]);

  const filteredEntities = useMemo(
    () => filterByDomain(entities, selectedDomain),
    [entities, selectedDomain]
  );

  const { nodes, edges } = useMemo(() => {
    const { nodes: rawNodes, edges: rawEdges } =
      buildNodesAndEdges(filteredEntities);
    return applyDagreLayout(rawNodes, rawEdges);
  }, [filteredEntities]);

  const hasRelationships = useMemo(
    () => entities.some((e) => e.relationships.length > 0),
    [entities]
  );

  const isLargeGraph =
    nodes.length > LARGE_NODE_THRESHOLD || edges.length > LARGE_EDGE_THRESHOLD;

  const handleFitView = useCallback(() => {
    fitView({ padding: 0.15, duration: 300 });
  }, [fitView]);

  const onInit = useCallback(() => {
    if (!initialFitDone.current) {
      // Small delay to let dagre positions settle
      setTimeout(() => fitView({ padding: 0.15 }), 50);
      initialFitDone.current = true;
    }
  }, [fitView]);

  // Empty state: no entities at all, or no entities with relationships
  if (entities.length === 0 || !hasRelationships) {
    return (
      <div
        data-testid="lineage-empty-state"
        className="flex flex-col items-center justify-center h-full text-center"
      >
        <h2 className="text-[18px] font-medium text-foreground mb-2">
          No entity relationships found
        </h2>
        <p className="text-[14px] text-muted-foreground max-w-md">
          Create references between entities to see the lineage graph.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-full" style={{ minHeight: 500 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50">
        {/* Domain filter */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="domain-filter"
            className="text-[12px] text-muted-foreground"
          >
            Domain:
          </label>
          <select
            id="domain-filter"
            data-testid="domain-filter"
            value={selectedDomain}
            onChange={(e) => setSelectedDomain(e.target.value)}
            className="bg-card border border-border rounded-lg px-2 py-1 text-[13px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">All Domains</option>
            {domains.map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        {/* Fit to view */}
        <button
          data-testid="fit-to-view"
          onClick={handleFitView}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-card text-[13px] text-foreground hover:bg-card/80 transition-colors"
          title="Fit to view"
        >
          <Maximize2 className="w-3.5 h-3.5" />
          Fit
        </button>
      </div>

      {/* Large graph warning */}
      {isLargeGraph && (
        <div
          data-testid="large-graph-warning"
          className="px-4 py-2 text-[13px] text-center border-b"
          style={{
            backgroundColor: "rgba(229,169,59,0.15)",
            borderColor: "#e5a93b",
            color: "#e5a93b",
          }}
        >
          Large graph — consider filtering by domain for better performance
        </div>
      )}

      {/* Graph */}
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={onInit}
          fitView
          minZoom={0.1}
          maxZoom={2.0}
          className="bg-background"
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#333340" gap={32} size={1} />
          <Controls
            showInteractive={false}
            className="bg-card border border-border rounded-lg"
          />
          <MiniMap
            nodeColor="#A477B2"
            maskColor="rgba(0,0,0,0.6)"
            className="bg-card border border-border rounded-lg"
          />
        </ReactFlow>
      </div>
    </div>
  );
}

export function LineageGraph({ entities }: LineageGraphProps) {
  return (
    <ReactFlowProvider>
      <LineageGraphInner entities={entities} />
    </ReactFlowProvider>
  );
}
