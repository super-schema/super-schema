"use client";

import { memo, useState, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { useRouter } from "next/navigation";

export interface EntityNodeData {
  label: string;
  slug: string;
  domainName: string;
  domainSlug: string;
  status: string;
  fieldCount: number;
  piiCount: number;
  sensitiveCount: number;
  description: string;
  fields: { name: string; type: string; classification?: string }[];
  [key: string]: unknown;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "#5bc27a",
  DRAFT: "#e5a93b",
  DEPRECATED: "#8a8694",
};

function EntityNodeInner({ data, id }: NodeProps) {
  const nodeData = data as unknown as EntityNodeData;
  const router = useRouter();
  const [showPopover, setShowPopover] = useState(false);

  const statusColor = STATUS_COLORS[nodeData.status] ?? STATUS_COLORS.DEPRECATED;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setShowPopover((prev) => !prev);
    },
    []
  );

  const handleOpenEditor = useCallback(() => {
    router.push(`/schemas/${nodeData.domainSlug}/${nodeData.slug || id}`);
  }, [router, nodeData.domainSlug, nodeData.slug, id]);

  const displayFields = nodeData.fields?.slice(0, 10) ?? [];
  const remainingFields = Math.max(0, (nodeData.fields?.length ?? 0) - 10);

  return (
    <div className="relative group">
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-primary !w-2 !h-2"
      />

      {/* Node card */}
      <div
        data-testid={`lineage-node-${id}`}
        onClick={handleClick}
        className="cursor-pointer min-w-[200px] rounded-[12px] border border-border bg-card p-3 shadow-lg transition-all hover:border-primary/50"
        style={{ width: 200 }}
      >
        {/* Status + Name */}
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: statusColor }}
          />
          <span className="text-[15px] font-medium font-mono text-foreground truncate leading-tight">
            {nodeData.label}
          </span>
        </div>

        {/* Field count + Classification badges */}
        <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
          <Badge variant="outline" className="text-[11px] h-4 px-1.5">
            {nodeData.fieldCount} fields
          </Badge>
          {nodeData.piiCount > 0 && (
            <Badge variant="pii" className="text-[11px] h-4 px-1.5">
              {nodeData.piiCount} PII
            </Badge>
          )}
          {nodeData.sensitiveCount > 0 && (
            <Badge variant="warning" className="text-[11px] h-4 px-1.5">
              {nodeData.sensitiveCount} SENSITIVE
            </Badge>
          )}
        </div>

        {/* Domain label */}
        <span className="text-[11px] text-muted-foreground">
          {nodeData.domainName}
        </span>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-primary !w-2 !h-2"
      />

      {/* Popover */}
      {showPopover && (
        <div
          data-testid={`lineage-popover-${id}`}
          className="absolute left-[210px] top-0 z-50 w-[320px] rounded-[12px] border border-border bg-popover backdrop-blur-md p-4 shadow-[0_4px_12px_rgba(0,0,0,0.4)]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            onClick={() => setShowPopover(false)}
            className="absolute top-2 right-2 text-muted-foreground hover:text-foreground text-sm"
            aria-label="Close popover"
          >
            &times;
          </button>

          {/* Entity name */}
          <h2 className="text-[18px] font-medium text-foreground mb-1 pr-6">
            {nodeData.label}
          </h2>

          {/* Description */}
          {nodeData.description && (
            <p className="text-[14px] text-muted-foreground mb-3 line-clamp-3">
              {nodeData.description}
            </p>
          )}

          {/* Field list */}
          {displayFields.length > 0 && (
            <div className="mb-3">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left pb-1 font-medium">Name</th>
                    <th className="text-left pb-1 font-medium">Type</th>
                    <th className="text-left pb-1 font-medium">Class.</th>
                  </tr>
                </thead>
                <tbody>
                  {displayFields.map((f, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-0.5 font-mono text-foreground">
                        {f.name}
                      </td>
                      <td className="py-0.5 text-muted-foreground">
                        {f.type}
                      </td>
                      <td className="py-0.5">
                        {f.classification && (
                          <Badge
                            variant={
                              f.classification === "PII"
                                ? "pii"
                                : f.classification === "SENSITIVE"
                                  ? "sensitive"
                                  : "outline"
                            }
                            className="text-[10px] h-3.5 px-1"
                          >
                            {f.classification}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {remainingFields > 0 && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  +{remainingFields} more
                </p>
              )}
            </div>
          )}

          {/* Open in Editor button */}
          <button
            data-testid={`open-editor-${id}`}
            onClick={handleOpenEditor}
            className="w-full rounded-lg bg-primary text-primary-foreground text-[14px] font-medium py-2 px-4 hover:bg-primary/90 transition-colors"
          >
            Open in Editor
          </button>
        </div>
      )}
    </div>
  );
}

export const EntityNode = memo(EntityNodeInner);
