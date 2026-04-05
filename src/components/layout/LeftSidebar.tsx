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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Fetch domains + entities for the tree
  useEffect(() => {
    async function fetchTree() {
      try {
        const res = await fetch("/api/domains-tree");
        if (res.ok) {
          const data = await res.json();
          setDomains(data);
          // Auto-expand system domains
          const systemIds = data
            .filter((d: DomainNode) => d.isSystem)
            .map((d: DomainNode) => d.id);
          setExpanded(new Set(systemIds));
        }
      } catch {
        // Silently fail — tree will show empty
      } finally {
        setLoading(false);
      }
    }
    fetchTree();
  }, [pathname]); // Refetch when navigating

  // Auto-expand the currently active domain from URL
  useEffect(() => {
    const match = pathname.match(/^\/schemas\/([^/]+)/);
    if (match) {
      const urlSlug = match[1];
      const domain = domains.find(
        (d) => d.slug === urlSlug
      );
      if (domain) {
        setExpanded((prev) => new Set([...prev, domain.id]));
      }
    }
  }, [pathname, domains]);

  // Filter tree by search
  const filteredDomains = useMemo(() => {
    if (!search.trim()) return domains;
    const q = search.toLowerCase();
    return domains
      .map((d) => ({
        ...d,
        entities: d.entities.filter((e) =>
          e.name.toLowerCase().includes(q)
        ),
      }))
      .filter(
        (d) =>
          d.name.toLowerCase().includes(q) || d.entities.length > 0
      );
  }, [domains, search]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  if (isCollapsed || width === 0) {
    return (
      <div
        data-testid="left-sidebar"
        data-collapsed="true"
        className="relative"
      >
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
            className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground outline-none w-full"
          />
        </div>
      </div>

      {/* Tree header */}
      <div className="px-space-3 py-space-1">
        <h3 className="text-caption text-muted-foreground uppercase tracking-wider">
          Explorer
        </h3>
      </div>

      {/* Domain tree */}
      <div className="flex-1 overflow-y-auto px-space-1 pb-space-3">
        {loading ? (
          <p className="text-body-small text-muted-foreground px-space-3 py-space-2">
            Loading...
          </p>
        ) : filteredDomains.length === 0 ? (
          <p className="text-body-small text-muted-foreground px-space-3 py-space-2">
            {search ? "No matches" : "No domains yet"}
          </p>
        ) : (
          filteredDomains.map((domain) => {
            const isExpanded = expanded.has(domain.id);
            const slug = domain.slug;
            const isActive = pathname.startsWith(`/schemas/${slug}`);

            return (
              <div key={domain.id}>
                {/* Domain node */}
                <div
                  className={`group flex items-center gap-space-1 px-space-2 py-1 rounded-md cursor-pointer transition-colors ${
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                  onClick={() => {
                    toggleExpand(domain.id);
                    router.push(`/schemas/${slug}`);
                  }}
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3 h-3 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3 h-3 shrink-0" />
                  )}
                  {isExpanded ? (
                    <FolderOpen className="w-4 h-4 shrink-0 text-primary" />
                  ) : (
                    <Folder className="w-4 h-4 shrink-0" />
                  )}
                  <span className="text-body-small truncate flex-1">
                    {domain.name}
                  </span>
                  <span className="text-caption opacity-60">
                    {domain.entities.length}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/schemas/${slug}/new`);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-accent rounded transition-opacity"
                    title="New Entity"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>

                {/* Entity children */}
                {isExpanded && domain.entities.length > 0 && (
                  <div className="ml-space-4">
                    {domain.entities.map((entity) => (
                      <div
                        key={entity.id}
                        className="flex items-center gap-space-2 px-space-2 py-0.5 rounded-md cursor-pointer text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
                        onClick={() =>
                          router.push(`/schemas/${slug}/${entity.slug}`)
                        }
                      >
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${getStatusColor(entity.status)}`}
                        />
                        <span className={`text-mono-small truncate ${entity.status === "RETIRED" ? "line-through" : ""}`}>
                          {entity.name}
                        </span>
                      </div>
                    ))}
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
