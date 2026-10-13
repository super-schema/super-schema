"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Folder,
  FolderOpen,
  Globe,
  Hash,
  Plus,
  RefreshCcw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDomainsTree } from "@/hooks/useDomainsTree";
import { cn } from "@/lib/utils";

interface LeftSidebarProps {
  width: number;
  isCollapsed: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}

export function LeftSidebar({
  width,
  isCollapsed,
  onMouseDown,
  onDoubleClick,
}: LeftSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [userExpandedDomains, setUserExpandedDomains] = useState<Set<string>>(new Set());
  const [userCollapsedDomains, setUserCollapsedDomains] = useState<Set<string>>(new Set());
  const [userExpandedCategories, setUserExpandedCategories] = useState<Set<string>>(new Set());
  const [userCollapsedCategories, setUserCollapsedCategories] = useState<Set<string>>(new Set());
  const {
    data: domains = [],
    isError,
    isLoading,
    refetch,
  } = useDomainsTree();

  const activeDomain = useMemo(() => {
    const match = pathname.match(/^\/schemas\/([^/]+)/);

    if (!match) {
      return undefined;
    }

    return domains.find((candidate) => candidate.slug === match[1]);
  }, [pathname, domains]);

  const expandedDomains = useMemo(() => {
    const defaults = domains
      .filter((domain) => domain.isSystem)
      .map((domain) => domain.id);
    const next = new Set(defaults);

    if (activeDomain) {
      next.add(activeDomain.id);
    }

    userExpandedDomains.forEach((id) => next.add(id));
    userCollapsedDomains.forEach((id) => next.delete(id));

    return next;
  }, [activeDomain, domains, userCollapsedDomains, userExpandedDomains]);

  const expandedCategories = useMemo(() => {
    const defaults = domains
      .filter((domain) => domain.isSystem)
      .map((domain) => `${domain.id}:entities`);
    const next = new Set(defaults);

    if (activeDomain) {
      next.add(`${activeDomain.id}:entities`);
    }

    userExpandedCategories.forEach((key) => next.add(key));
    userCollapsedCategories.forEach((key) => next.delete(key));

    return next;
  }, [activeDomain, domains, userCollapsedCategories, userExpandedCategories]);

  const filteredDomains = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) {
      return domains;
    }

    return domains
      .map((domain) => ({
        ...domain,
        entities: domain.entities.filter((entity) =>
          entity.name.toLowerCase().includes(query)
        ),
      }))
      .filter(
        (domain) =>
          domain.name.toLowerCase().includes(query) || domain.entities.length > 0
      );
  }, [domains, search]);

  function toggleDomain(id: string) {
    if (expandedDomains.has(id)) {
      setUserCollapsedDomains((prev) => new Set([...prev, id]));
      setUserExpandedDomains((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }

    setUserExpandedDomains((prev) => new Set([...prev, id]));
    setUserCollapsedDomains((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function toggleCategory(key: string) {
    if (expandedCategories.has(key)) {
      setUserCollapsedCategories((prev) => new Set([...prev, key]));
      setUserExpandedCategories((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }

    setUserExpandedCategories((prev) => new Set([...prev, key]));
    setUserCollapsedCategories((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  if (isCollapsed || width === 0) {
    return (
      <div data-testid="left-sidebar" data-collapsed="true" className="relative">
        <ResizeHandle onMouseDown={onMouseDown} onDoubleClick={onDoubleClick} />
      </div>
    );
  }

  return (
    <div
      data-testid="left-sidebar"
      data-collapsed="false"
      className="relative surface-1 border-r border-border flex flex-col animate-panel-expand overflow-hidden"
      style={{ width, minWidth: width }}
    >
      <div className="sticky top-0 z-10 surface-1 border-b border-border/60 p-space-3">
        <div className="flex items-center gap-space-2 bg-muted rounded-lg px-space-3 py-1.5 ring-1 ring-transparent focus-within:ring-primary/30">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Filter domains, entities..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground/40 outline-none w-full"
          />
        </div>
      </div>

      <div className="px-space-3 py-space-2 flex items-center justify-between">
        <h3 className="text-caption text-muted-foreground uppercase tracking-wider">
          Explorer
        </h3>
        {!isLoading && !isError && (
          <span className="text-[10px] text-muted-foreground/70">
            {domains.length} {domains.length === 1 ? "domain" : "domains"}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-space-1 pb-space-3">
        {isLoading ? (
          <SidebarSkeleton />
        ) : isError ? (
          <SidebarError onRetry={() => void refetch()} />
        ) : filteredDomains.length === 0 ? (
          <SidebarEmptyState hasSearch={Boolean(search.trim())} />
        ) : (
          filteredDomains.map((domain) => {
            const domainPath = `/schemas/${domain.slug}`;
            const isDomainExpanded = expandedDomains.has(domain.id);
            const isDomainRoute =
              pathname === domainPath || pathname.startsWith(`${domainPath}/`);
            const activeTab = getActiveTab();
            const isDomainRoot = pathname === domainPath;
            const isEntitiesActive = isDomainRoute && !activeTab;
            const typesCount =
              domain.sharedEnumCount +
              domain.customScalarCount +
              domain.unionTypeCount;
            const isEntitiesExpanded = expandedCategories.has(
              `${domain.id}:entities`
            );
            // Entities live under a product (Domain › Product › Entity). The
            // flat "Entities" group routes to that product's workspace; use the
            // listed entities' product, falling back to the default product.
            const entitiesProductSlug =
              domain.entities[0]?.productSlug ?? "default";
            const productPath = `${domainPath}/${entitiesProductSlug}`;

            return (
              <div key={domain.id} className="mb-1">
                <div
                  data-active={isDomainRoot ? "true" : "false"}
                  className={cn(
                    "group flex items-center gap-space-1 px-space-2 py-1 rounded-md cursor-pointer transition-colors",
                    isDomainRoot && "bg-accent text-foreground font-medium",
                    !isDomainRoot &&
                      isDomainRoute &&
                      "text-foreground",
                    !isDomainRoute &&
                      "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                  onClick={() => {
                    toggleDomain(domain.id);
                    router.push(domainPath);
                  }}
                >
                  {isDomainExpanded ? (
                    <ChevronDown className="w-3 h-3 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3 h-3 shrink-0" />
                  )}
                  {isDomainExpanded ? (
                    <FolderOpen className="w-4 h-4 shrink-0 text-primary" />
                  ) : (
                    <Folder className="w-4 h-4 shrink-0" />
                  )}
                  <span className="text-body-small truncate flex-1">
                    {domain.name}
                  </span>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      router.push(`${domainPath}/${entitiesProductSlug}/new`);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-accent rounded transition-opacity"
                    title="New Entity"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>

                {isDomainExpanded && (
                  <div className="ml-3 border-l border-border/50 pl-1 py-0.5">
                    <SidebarCategory
                      active={isEntitiesActive}
                      count={domain.entities.length}
                      expanded={isEntitiesExpanded}
                      icon={<Database className="w-3 h-3 shrink-0" />}
                      label="Entities"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleCategory(`${domain.id}:entities`);
                        router.push(productPath);
                      }}
                    />

                    {isEntitiesExpanded &&
                      domain.entities.map((entity) => {
                        const entityPath = `${domainPath}/${entity.productSlug}/${entity.slug}`;
                        const isEntityActive = pathname === entityPath;

                        return (
                          <div
                            key={entity.id}
                            data-active={isEntityActive ? "true" : "false"}
                            className={cn(
                              "flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors ml-4",
                              isEntityActive
                                ? "bg-accent text-foreground font-medium"
                                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                            )}
                            onClick={() => router.push(entityPath)}
                          >
                            <span
                              className={cn(
                                "w-1.5 h-1.5 rounded-full shrink-0",
                                getStatusColor(entity.status)
                              )}
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
                      })}

                    <SidebarLeafCategory
                      active={isDomainRoute && activeTab === "types"}
                      count={typesCount}
                      icon={<Hash className="w-3 h-3 shrink-0" />}
                      label="Types"
                      onClick={() => router.push(`${domainPath}?tab=types`)}
                    />

                    <SidebarLeafCategory
                      active={isDomainRoute && activeTab === "apis"}
                      count={domain.serviceCount}
                      icon={<Globe className="w-3 h-3 shrink-0" />}
                      label="APIs"
                      onClick={() => router.push(`${domainPath}?tab=apis`)}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <ResizeHandle onMouseDown={onMouseDown} onDoubleClick={onDoubleClick} />
    </div>
  );
}

function getActiveTab() {
  if (typeof window === "undefined") {
    return null;
  }

  return new URLSearchParams(window.location.search).get("tab");
}

function getStatusColor(status: string) {
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

function SidebarCategory({
  active,
  count,
  expanded,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  expanded: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
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

function SidebarLeafCategory({
  active,
  count,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <div
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

function CountBadge({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-muted px-1.5 py-px text-[10px] leading-none text-muted-foreground">
      {count}
    </span>
  );
}

function SidebarSkeleton() {
  return (
    <div className="px-space-2 py-space-1 space-y-space-2" aria-label="Loading domains">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="space-y-1">
          <div className="h-5 rounded-md bg-muted/70 animate-pulse" />
          <div className="ml-5 h-4 w-3/4 rounded-md bg-muted/40 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function SidebarEmptyState({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="px-space-3 py-space-4 text-body-small text-muted-foreground">
      {hasSearch ? "No domains or entities match this filter." : "No domains yet."}
    </div>
  );
}

function SidebarError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-space-2 rounded-lg border border-destructive/30 bg-destructive/5 p-space-3 text-body-small text-muted-foreground">
      <p className="mb-space-2 text-foreground">Could not load the explorer.</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCcw className="mr-1.5 h-3 w-3" /> Retry
      </Button>
    </div>
  );
}

function ResizeHandle({
  onMouseDown,
  onDoubleClick,
}: {
  onMouseDown: (event: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      data-testid="sidebar-handle"
      className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/30 animate-field-hover z-10"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
