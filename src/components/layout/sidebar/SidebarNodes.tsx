"use client";

import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExplorerEntity } from "@/lib/navigation/build-explorer-tree";

export function getStatusColor(status: string) {
  switch (status) {
    case "ACTIVE":
      return "bg-success";
    case "DRAFT":
      return "bg-warning";
    case "DEPRECATED":
      return "bg-[#e88a3b]";
    case "RETIRED":
      return "bg-muted-foreground";
    default:
      return "bg-muted-foreground";
  }
}

export function CountBadge({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-muted px-1.5 py-px text-[10px] leading-none text-muted-foreground">
      {count}
    </span>
  );
}

/**
 * A level node in the explorer (Enterprise, Domain or Product). The chevron
 * button is the only control that collapses; clicking the row navigates and
 * keeps the node expanded.
 */
export function SidebarNodeRow({
  active,
  addTitle,
  expanded,
  icon,
  inRoute,
  label,
  onAdd,
  onNavigate,
  onToggle,
  testId,
}: {
  /** The current route is exactly this node's workspace. */
  active: boolean;
  addTitle: string;
  expanded: boolean;
  icon: React.ReactNode;
  /** The current route is this node's workspace or anything beneath it. */
  inRoute: boolean;
  label: string;
  onAdd: () => void;
  onNavigate: () => void;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-active={active ? "true" : "false"}
      className={cn(
        "group flex items-center gap-space-1 px-space-2 py-1 rounded-md cursor-pointer transition-colors",
        active && "bg-accent text-foreground font-medium",
        !active && inRoute && "text-foreground",
        !inRoute && "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
      onClick={onNavigate}
    >
      <button
        type="button"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        aria-expanded={expanded}
        className="shrink-0 rounded hover:bg-accent p-0.5 -m-0.5"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
      </button>
      {icon}
      <span className="text-body-small truncate flex-1">{label}</span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onAdd();
        }}
        className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-accent rounded transition-opacity"
        title={addTitle}
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}

export function SidebarCategory({
  active,
  count,
  expanded,
  icon,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  count: number;
  expanded: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors",
        active
          ? "text-primary font-medium bg-primary/5"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
      onClick={onClick}
    >
      {expanded ? (
        <ChevronDown className="w-2.5 h-2.5 shrink-0" />
      ) : (
        <ChevronRight className="w-2.5 h-2.5 shrink-0" />
      )}
      {icon}
      <span className="text-[11px] truncate flex-1">{label}</span>
      <CountBadge count={count} />
    </div>
  );
}

export function SidebarLeafCategory({
  active,
  count,
  icon,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  count: number;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors",
        active
          ? "text-primary font-medium bg-primary/5"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
      onClick={onClick}
    >
      <span className="ml-[14px]">{icon}</span>
      <span className="text-[11px] truncate flex-1">{label}</span>
      {count > 0 && <CountBadge count={count} />}
    </div>
  );
}

export function SidebarEntityRow({
  active,
  entity,
  onClick,
}: {
  active: boolean;
  entity: ExplorerEntity;
  onClick: () => void;
}) {
  return (
    <div
      data-active={active ? "true" : "false"}
      className={cn(
        "flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors ml-4",
        active
          ? "bg-accent text-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
      onClick={onClick}
    >
      <span
        className={cn("w-1.5 h-1.5 rounded-full shrink-0", getStatusColor(entity.status))}
      />
      <span
        className={cn(
          "text-[11px] truncate",
          entity.status === "RETIRED" && "line-through"
        )}
      >
        {entity.name}
      </span>
    </div>
  );
}
