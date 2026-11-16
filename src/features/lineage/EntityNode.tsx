"use client";

import { memo, useState, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pluralize } from "@/lib/pluralize";
import { useRouter } from "next/navigation";
import { assetHref } from "@/lib/navigation/asset-href";

export interface EntityNodeData {
  label: string;
  slug: string;
  domainName: string;
  /** null for a tenant-level (Enterprise) entity. */
  domainSlug: string | null;
  productSlug: string | null;
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
    router.push(
      assetHref({
        kind: "entity",
        slug: nodeData.slug || id,
        domainSlug: nodeData.domainSlug,
        productSlug: nodeData.productSlug,
      })
    );
  }, [router, nodeData.domainSlug, nodeData.productSlug, nodeData.slug, id]);

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
            {pluralize(nodeData.fieldCount, "field")}
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
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setShowPopover(false)}
            className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
            aria-label="Close popover"
          >
            &times;
          </Button>

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
              <Table className="text-[12px]">
                <TableHeader>
                  <TableRow className="text-muted-foreground hover:bg-transparent">
                    <TableHead className="h-auto p-0 pb-1 text-muted-foreground">Name</TableHead>
                    <TableHead className="h-auto p-0 pb-1 text-muted-foreground">Type</TableHead>
                    <TableHead className="h-auto p-0 pb-1 text-muted-foreground">Class.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayFields.map((f, i) => (
                    <TableRow key={i} className="border-border/50">
                      <TableCell className="p-0 py-0.5 font-mono text-foreground">
                        {f.name}
                      </TableCell>
                      <TableCell className="p-0 py-0.5 text-muted-foreground">
                        {f.type}
                      </TableCell>
                      <TableCell className="p-0 py-0.5">
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
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {remainingFields > 0 && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  +{remainingFields} more
                </p>
              )}
            </div>
          )}

          {/* Open in Editor button */}
          <Button
            size="lg"
            data-testid={`open-editor-${id}`}
            onClick={handleOpenEditor}
            className="w-full"
          >
            Open in Editor
          </Button>
        </div>
      )}
    </div>
  );
}

export const EntityNode = memo(EntityNodeInner);
