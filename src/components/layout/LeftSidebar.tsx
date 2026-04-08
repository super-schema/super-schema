"use client";

import { useState, useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Search,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Folder,
  Plus,
  Database,
  Hash,
  Globe,
} from "lucide-react";

interface DomainNode {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  entities: {
    id: string;
    name: string;
    slug: string;
    status: string;
  }[];
  modelCount: number;
  decoratorCount: number;
  sharedEnumCount: number;
  customScalarCount: number;
  unionTypeCount: number;
  serviceCount: number;
}

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
  const [domains, setDomains] = useState<DomainNode[]>([]);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchTree() {
      try {
        const res = await fetch("/api/domains-tree");
        if (res.ok) {
          const data = await res.json();
          setDomains(data);
          const systemIds = data
            .filter((d: DomainNode) => d.isSystem)
            .map((d: DomainNode) => d.id);
          setExpandedDomains(new Set(systemIds));
          // Auto-expand entities category for system domains
          setExpandedCategories(new Set(systemIds.map((id: string) => `${id}:entities`)));
        }
      } catch {
        // Silently fail
      } finally {
        setLoading(false);
      }
    }
    fetchTree();
  }, [pathname]);

  // Auto-expand active domain + entities category
  useEffect(() => {
    const match = pathname.match(/^\/schemas\/([^/]+)/);
    if (match) {
      const urlSlug = match[1];
      const domain = domains.find((d) => d.slug === urlSlug);
      if (domain) {
        setExpandedDomains((prev) => new Set([...prev, domain.id]));
        setExpandedCategories((prev) => new Set([...prev, `${domain.id}:entities`]));
      }
    }
  }, [pathname, domains]);

  const filteredDomains = useMemo(() => {
    if (!search.trim()) return domains;
    const q = search.toLowerCase();
    return domains
      .map((d) => ({
        ...d,
        entities: d.entities.filter((e) => e.name.toLowerCase().includes(q)),
      }))
      .filter((d) => d.name.toLowerCase().includes(q) || d.entities.length > 0);
  }, [domains, search]);

  function toggleDomain(id: string) {
    setExpandedDomains((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleCategory(key: string) {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function getStatusColor(status: string) {
    switch (status) {
      case "ACTIVE": return "bg-success";
      case "DRAFT": return "bg-warning";
      case "DEPRECATED": return "bg-[#e88a3b]";
      case "RETIRED": return "bg-muted-foreground";
      default: return "bg-muted-foreground";
    }
  }

  // Check if current path matches a tab
  const activeTab = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : ""
  ).get("tab");

  if (isCollapsed || width === 0) {
    return (
      <div data-testid="left-sidebar" data-collapsed="true" className="relative">
        <div
          data-testid="sidebar-handle"
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/30 animate-field-hover z-10"
          onMouseDown={onMouseDown}
          onDoubleClick={onDoubleClick}
        />
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
      {/* Search */}
      <div className="p-space-3">
        <div className="flex items-center gap-space-2 bg-muted rounded-lg px-space-3 py-1.5">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Filter..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground/40 outline-none w-full"
          />
        </div>
      </div>

      <div className="px-space-3 py-space-1">
        <h3 className="text-caption text-muted-foreground uppercase tracking-wider">Explorer</h3>
      </div>

      {/* Domain tree */}
      <div className="flex-1 overflow-y-auto px-space-1 pb-space-3">
        {loading ? (
          <p className="text-body-small text-muted-foreground px-space-3 py-space-2">Loading...</p>
        ) : filteredDomains.length === 0 ? (
          <p className="text-body-small text-muted-foreground px-space-3 py-space-2">
            {search ? "No matches" : "No domains yet"}
          </p>
        ) : (
          filteredDomains.map((domain) => {
            const isDomainExpanded = expandedDomains.has(domain.id);
            const slug = domain.slug;
            const isActive = pathname.startsWith(`/schemas/${slug}`);
            const typesCount = domain.sharedEnumCount + domain.customScalarCount + domain.unionTypeCount;
            const isEntitiesExpanded = expandedCategories.has(`${domain.id}:entities`);

            return (
              <div key={domain.id} className="mb-0.5">
                {/* Domain node */}
                <div
                  className={`group flex items-center gap-space-1 px-space-2 py-1 rounded-md cursor-pointer transition-colors ${
                    isActive && !pathname.includes("/") ? "bg-accent text-foreground" : ""
                  } ${isActive ? "text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}
                  onClick={() => {
                    toggleDomain(domain.id);
                    router.push(`/schemas/${slug}`);
                  }}
                >
                  {isDomainExpanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                  {isDomainExpanded ? <FolderOpen className="w-4 h-4 shrink-0 text-primary" /> : <Folder className="w-4 h-4 shrink-0" />}
                  <span className="text-body-small truncate flex-1">{domain.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); router.push(`/schemas/${slug}/new`); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-accent rounded transition-opacity"
                    title="New Entity"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>

                {/* Categories */}
                {isDomainExpanded && (
                  <div className="ml-3">
                    {/* Entities category — collapsible */}
                    <div
                      className={`flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors ${
                        isActive && !activeTab ? "text-primary font-medium" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCategory(`${domain.id}:entities`);
                        router.push(`/schemas/${slug}`);
                      }}
                    >
                      {isEntitiesExpanded ? <ChevronDown className="w-2.5 h-2.5 shrink-0" /> : <ChevronRight className="w-2.5 h-2.5 shrink-0" />}
                      <Database className="w-3 h-3 shrink-0" />
                      <span className="text-[11px] truncate flex-1">Entities</span>
                      <span className="text-[10px] opacity-50">{domain.entities.length}</span>
                    </div>

                    {/* Entity list — collapsible */}
                    {isEntitiesExpanded && domain.entities.map((entity) => {
                      const isEntityActive = pathname === `/schemas/${slug}/${entity.slug}`;
                      return (
                        <div
                          key={entity.id}
                          className={`flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors ml-4 ${
                            isEntityActive ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => router.push(`/schemas/${slug}/${entity.slug}`)}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStatusColor(entity.status)}`} />
                          <span className={`text-[11px] truncate ${entity.status === "RETIRED" ? "line-through" : ""}`}>
                            {entity.name}
                          </span>
                        </div>
                      );
                    })}

                    {/* Types category — always visible */}
                    <div
                      className={`flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors ${
                        isActive && activeTab === "types" ? "text-primary font-medium" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                      onClick={() => router.push(`/schemas/${slug}?tab=types`)}
                    >
                      <Hash className="w-3 h-3 shrink-0 ml-[14px]" />
                      <span className="text-[11px] truncate flex-1">Types</span>
                      {typesCount > 0 && <span className="text-[10px] opacity-50">{typesCount}</span>}
                    </div>

                    {/* APIs category — always visible */}
                    <div
                      className={`flex items-center gap-1.5 px-space-2 py-0.5 rounded-md cursor-pointer transition-colors ${
                        isActive && activeTab === "apis" ? "text-primary font-medium" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                      onClick={() => router.push(`/schemas/${slug}?tab=apis`)}
                    >
                      <Globe className="w-3 h-3 shrink-0 ml-[14px]" />
                      <span className="text-[11px] truncate flex-1">APIs</span>
                      {domain.serviceCount > 0 && <span className="text-[10px] opacity-50">{domain.serviceCount}</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Drag handle */}
      <div
        data-testid="sidebar-handle"
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/30 animate-field-hover z-10"
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
