"use client";

import { memo } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExplorerEntity } from "@/lib/navigation/build-explorer-tree";

/**
 * Rows are memoized and receive only primitives, stable component references
 * and stable callbacks (`onNavigate(href, expandKey?)`, `onToggle(key)`), so a
 * pathname change re-renders just the rows whose own props changed.
 */

/** A lucide-style icon component; passed by reference so memoization holds. */
export type SidebarIcon = React.ComponentType<{ className?: string }>;

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

/** Spinner shown on the row whose navigation transition is still pending. */
function PendingSpinner() {
  return <Loader2 aria-hidden="true" className="w-3 h-3 shrink-0 animate-spin text-muted-foreground" />;
}

/** Navigation handler shared by every row: `expandKey` is expanded before navigating. */
export type SidebarNavigate = (href: string, expandKey?: string) => void;

/**
 * A level node in the explorer (Enterprise, Domain or Product). The chevron
 * button is the only control that collapses; clicking the row navigates and
 * keeps the node expanded.
 */
export const SidebarNodeRow = memo(function SidebarNodeRow({
  active,
  addHref,
  addTitle,
  expanded,
  expandedIcon,
  href,
  icon: Icon,
  inRoute,
  label,
  nodeKey,
  onNavigate,
  onToggle,
  pending,
  testId,
}: {
  /** The current route is exactly this node's workspace. */
  active: boolean;
  /** Where the row's "+" button navigates. */
  addHref: string;
  addTitle: string;
  expanded: boolean;
  /** Icon used while expanded (defaults to `icon`); an expanded node's icon is highlighted. */
  expandedIcon?: SidebarIcon;
  /** The node's workspace URL. */
  href: string;
  icon: SidebarIcon;
  /** The current route is this node's workspace or anything beneath it. */
  inRoute: boolean;
  label: string;
  /** Expansion key of this node. */
  nodeKey: string;
  onNavigate: SidebarNavigate;
  onToggle: (key: string) => void;
  /** A navigation started from this row is still pending. */
  pending: boolean;
  testId?: string;
}) {
  const NodeIcon = expanded ? (expandedIcon ?? Icon) : Icon;

  return (
    <div
      data-testid={testId}
      data-active={active ? "true" : "false"}
      data-pending={pending ? "true" : "false"}
      aria-busy={pending || undefined}
      className={cn(
        "group flex items-center gap-space-1 px-space-2 py-1 rounded-md cursor-pointer transition-colors",
        active && "bg-accent text-foreground font-medium",
        !active && inRoute && "text-foreground",
        !inRoute && "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        pending && "opacity-70"
      )}
      onClick={() => onNavigate(href, nodeKey)}
    >
      <button
        type="button"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        aria-expanded={expanded}
        className="shrink-0 rounded hover:bg-accent p-0.5 -m-0.5"
        onClick={(event) => {
          event.stopPropagation();
          onToggle(nodeKey);
        }}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
      </button>
      <NodeIcon className={cn("w-4 h-4 shrink-0", expanded && "text-primary")} />
      <span className="text-body-small truncate flex-1">{label}</span>
      {pending && <PendingSpinner />}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onNavigate(addHref);
        }}
        className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-accent rounded transition-opacity"
        title={addTitle}
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
});

/**
 * An expandable category (e.g. Entities). Same rule as the level nodes: the
 * chevron is the only control that collapses; clicking the row navigates and
 * keeps the category expanded.
 */
export const SidebarCategory = memo(function SidebarCategory({
  active,
  count,
  expanded,
  href,
  icon: Icon,
  label,
  nodeKey,
  onNavigate,
  onToggle,
  pending,
  testId,
}: {
  active: boolean;
  count: number;
  expanded: boolean;
  href: string;
  icon: SidebarIcon;
  label: string;
  nodeKey: string;
  onNavigate: SidebarNavigate;
  onToggle: (key: string) => void;
  pending: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-active={active ? "true" : "false"}
      data-pending={pending ? "true" : "false"}
      aria-busy={pending || undefined}
      className={cn(
        "flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors",
        active
          ? "text-primary font-medium bg-primary/5"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        pending && "opacity-70"
      )}
      onClick={() => onNavigate(href, nodeKey)}
    >
      <button
        type="button"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        aria-expanded={expanded}
        className="shrink-0 rounded hover:bg-accent p-0.5 -m-0.5"
        onClick={(event) => {
          event.stopPropagation();
          onToggle(nodeKey);
        }}
      >
        {expanded ? (
          <ChevronDown className="w-2.5 h-2.5 shrink-0" />
        ) : (
          <ChevronRight className="w-2.5 h-2.5 shrink-0" />
        )}
      </button>
      <Icon className="w-3 h-3 shrink-0" />
      <span className="text-[11px] truncate flex-1">{label}</span>
      {pending && <PendingSpinner />}
      <CountBadge count={count} />
    </div>
  );
});

export const SidebarLeafCategory = memo(function SidebarLeafCategory({
  active,
  count,
  href,
  icon: Icon,
  label,
  onNavigate,
  pending,
  testId,
}: {
  active: boolean;
  count: number;
  href: string;
  icon: SidebarIcon;
  label: string;
  onNavigate: SidebarNavigate;
  pending: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-active={active ? "true" : "false"}
      data-pending={pending ? "true" : "false"}
      aria-busy={pending || undefined}
      className={cn(
        "flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors",
        active
          ? "text-primary font-medium bg-primary/5"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        pending && "opacity-70"
      )}
      onClick={() => onNavigate(href)}
    >
      <span className="ml-[14px]">
        <Icon className="w-3 h-3 shrink-0" />
      </span>
      <span className="text-[11px] truncate flex-1">{label}</span>
      {pending && <PendingSpinner />}
      {count > 0 && <CountBadge count={count} />}
    </div>
  );
});

export const SidebarEntityRow = memo(function SidebarEntityRow({
  active,
  entity,
  href,
  onNavigate,
  pending,
}: {
  active: boolean;
  entity: ExplorerEntity;
  href: string;
  onNavigate: SidebarNavigate;
  pending: boolean;
}) {
  return (
    <div
      data-testid={`entity-${entity.id}`}
      data-active={active ? "true" : "false"}
      data-pending={pending ? "true" : "false"}
      aria-busy={pending || undefined}
      className={cn(
        "flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors ml-4",
        active
          ? "bg-accent text-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        pending && "opacity-70"
      )}
      onClick={() => onNavigate(href)}
    >
      <span
        className={cn("w-1.5 h-1.5 rounded-full shrink-0", getStatusColor(entity.status))}
      />
      <span
        className={cn(
          "text-[11px] truncate flex-1",
          entity.status === "RETIRED" && "line-through"
        )}
      >
        {entity.name}
      </span>
      {pending && <PendingSpinner />}
    </div>
  );
});
