"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";

interface EntityNodeData {
  label: string;
  domainName: string;
  status: string;
  fieldCount: number;
  [key: string]: unknown;
}

export function EntityNode({ data }: NodeProps) {
  const nodeData = data as unknown as EntityNodeData;
  const statusColor =
    nodeData.status === "ACTIVE"
      ? "bg-success"
      : nodeData.status === "DRAFT"
        ? "bg-warning"
        : "bg-muted-foreground";

  return (
    <div className="surface-glass rounded-xl border border-border p-space-3 min-w-[180px] shadow-lg">
      <Handle type="target" position={Position.Left} className="!bg-primary" />

      <div className="flex items-center gap-space-2 mb-space-1">
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="text-heading-3 text-foreground font-mono text-sm">
          {nodeData.label}
        </span>
      </div>

      <div className="flex items-center gap-space-2">
        <Badge variant="outline" className="text-caption">
          {nodeData.fieldCount} fields
        </Badge>
        <span className="text-caption text-muted-foreground">
          {nodeData.domainName}
        </span>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
}
