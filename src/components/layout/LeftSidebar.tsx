"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  Database,
  Folder,
  FolderOpen,
  Globe,
  Hash,
  Package,
  RefreshCcw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDomainsTree } from "@/hooks/useDomainsTree";
import { assetHref } from "@/lib/navigation/asset-href";
import type {
  ExplorerDomain,
  ExplorerEntity,
  ExplorerProduct,
} from "@/lib/navigation/build-explorer-tree";
import { cn } from "@/lib/utils";
import {
  SidebarCategory,
  SidebarEntityRow,
  SidebarLeafCategory,
  SidebarNodeRow,
} from "@/components/layout/sidebar/SidebarNodes";

interface LeftSidebarProps {
  width: number;
  isCollapsed: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}

const ENTERPRISE_KEY = "enterprise";
const ENTERPRISE_ENTITIES_KEY = "enterprise:entities";
const domainKey = (id: string) => `d:${id}`;
const productKey = (id: string) => `p:${id}`;
const productEntitiesKey = (id: string) => `p:${id}:entities`;

function isWithin(pathname: string, base: string) {
  return pathname === base || pathname.startsWith(`${base}/`);
}

// `types` is the legacy alias of the `data-types` workspace tab.
function isDataTypesTab(tab: string | null) {
  return tab === "data-types" || tab === "types";
}

/**
 * `useSearchParams` opts a client component out of static prerendering, and
 * the dashboard layout wraps statically rendered pages — so the explorer
 * lives behind a Suspense boundary with a skeleton of the same width.
 */
export function LeftSidebar(props: LeftSidebarProps) {
  return (
    <Suspense fallback={<LeftSidebarFallback {...props} />}>
      <ExplorerSidebar {...props} />
    </Suspense>
  );
}

function LeftSidebarFallback({ width, isCollapsed }: LeftSidebarProps) {
  if (isCollapsed || width === 0) {
    return <div data-testid="left-sidebar" data-collapsed="true" className="relative" />;
  }

  return (
    <div
      data-testid="left-sidebar"
      data-collapsed="false"
      className="relative surface-1 border-r border-border flex flex-col overflow-hidden"
      style={{ width, minWidth: width }}
    >
      <SidebarSkeleton />
    </div>
  );
}

function ExplorerSidebar({
  width,
  isCollapsed,
  onMouseDown,
  onDoubleClick,
}: LeftSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = searchParams?.get("tab") ?? null;
  const [search, setSearch] = useState("");
  // Explicit user choices; anything absent falls back to the route-derived defaults.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const { data: tree, isError, isLoading, refetch } = useDomainsTree();

  const domains = useMemo(() => tree?.domains ?? [], [tree]);

  const activeDomain = useMemo(() => {
    const match = pathname.match(/^\/schemas\/([^/]+)/);
    return match ? domains.find((candidate) => candidate.slug === match[1]) : undefined;
  }, [pathname, domains]);

  const defaultExpanded = useMemo(() => {
    const next = new Set<string>([ENTERPRISE_KEY, ENTERPRISE_ENTITIES_KEY]);
    if (activeDomain) {
      next.add(domainKey(activeDomain.id));
      for (const product of activeDomain.products) {
        next.add(productKey(product.id));
        next.add(productEntitiesKey(product.id));
      }
    }
    return next;
  }, [activeDomain]);

  const isExpanded = (key: string) => overrides[key] ?? defaultExpanded.has(key);
  const setExpanded = (key: string, open: boolean) =>
    setOverrides((prev) => ({ ...prev, [key]: open }));
  const toggle = (key: string) => setExpanded(key, !isExpanded(key));

  const query = search.trim().toLowerCase();
  const enterpriseEntities = useMemo(
    () =>
      query
        ? (tree?.enterprise.entities ?? []).filter((e) => e.name.toLowerCase().includes(query))
        : (tree?.enterprise.entities ?? []),
    [tree, query]
  );

  const filteredDomains = useMemo<ExplorerDomain[]>(() => {
    if (!query) return domains;
    const matches = (name: string) => name.toLowerCase().includes(query);

    return domains
      .map((domain) => ({
        ...domain,
        products: domain.products
          .map((product) => ({
            ...product,
            entities: product.entities.filter((entity) => matches(entity.name)),
          }))
          .filter((product) => matches(product.name) || product.entities.length > 0),
      }))
      .filter((domain) => matches(domain.name) || domain.products.length > 0);
  }, [domains, query]);

  if (isCollapsed || width === 0) {
    return (
      <div data-testid="left-sidebar" data-collapsed="true" className="relative">
        <ResizeHandle onMouseDown={onMouseDown} onDoubleClick={onDoubleClick} />
      </div>
    );
  }

  const enterpriseHref = assetHref({ kind: "enterprise" });
  const enterpriseDataTypes = tree?.enterprise.counts.dataTypes ?? 0;

  function renderEntities(
    entities: ExplorerEntity[],
    domainSlug: string | null,
    productSlug: string | null
  ) {
    return entities.map((entity) => {
      const href = assetHref({ kind: "entity", slug: entity.slug, domainSlug, productSlug });
      return (
        <SidebarEntityRow
          key={entity.id}
          active={pathname === href}
          entity={entity}
          onClick={() => router.push(href)}
        />
      );
    });
  }

  function renderProduct(domain: ExplorerDomain, product: ExplorerProduct) {
    const base = assetHref({ kind: "product", domainSlug: domain.slug, productSlug: product.slug });
    const key = productKey(product.id);
    const entitiesKey = productEntitiesKey(product.id);
    const expanded = isExpanded(key);
    const entitiesExpanded = isExpanded(entitiesKey);
    const inRoute = isWithin(pathname, base);

    return (
      <div key={product.id} className="mb-0.5">
        <SidebarNodeRow
          testId={`product-${product.id}`}
          active={pathname === base}
          inRoute={inRoute}
          expanded={expanded}
          icon={<Package className={cn("w-4 h-4 shrink-0", expanded && "text-primary")} />}
          label={product.name}
          addTitle="New Entity"
          onToggle={() => toggle(key)}
          onNavigate={() => {
            setExpanded(key, true);
            router.push(base);
          }}
          onAdd={() =>
            router.push(
              assetHref({ kind: "newEntity", domainSlug: domain.slug, productSlug: product.slug })
            )
          }
        />

        {expanded && (
          <div className="ml-3 border-l border-border/50 pl-1 py-0.5">
            {product.entities.length > 0 && (
              <>
                <SidebarCategory
                  testId={`product-${product.id}-entities`}
                  active={inRoute && !activeTab}
                  count={product.entities.length}
                  expanded={entitiesExpanded}
                  icon={<Database className="w-3 h-3 shrink-0" />}
                  label="Entities"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(entitiesKey);
                    router.push(base);
                  }}
                />
                {entitiesExpanded && renderEntities(product.entities, domain.slug, product.slug)}
              </>
            )}

            {product.counts.dataTypes > 0 && (
              <SidebarLeafCategory
                testId={`product-${product.id}-data-types`}
                active={pathname === base && isDataTypesTab(activeTab)}
                count={product.counts.dataTypes}
                icon={<Hash className="w-3 h-3 shrink-0" />}
                label="Data Types"
                onClick={() =>
                  router.push(
                    assetHref({ kind: "dataTypes", domainSlug: domain.slug, productSlug: product.slug })
                  )
                }
              />
            )}

            {product.counts.apis > 0 && (
              <SidebarLeafCategory
                testId={`product-${product.id}-apis`}
                active={pathname === base && activeTab === "apis"}
                count={product.counts.apis}
                icon={<Globe className="w-3 h-3 shrink-0" />}
                label="APIs"
                onClick={() =>
                  router.push(
                    assetHref({ kind: "apis", domainSlug: domain.slug, productSlug: product.slug })
                  )
                }
              />
            )}
          </div>
        )}
      </div>
    );
  }

  function renderDomain(domain: ExplorerDomain) {
    const base = assetHref({ kind: "domain", domainSlug: domain.slug });
    const key = domainKey(domain.id);
    const expanded = isExpanded(key);

    return (
      <div key={domain.id} className="mb-1">
        <SidebarNodeRow
          testId={`domain-${domain.id}`}
          active={pathname === base}
          inRoute={isWithin(pathname, base)}
          expanded={expanded}
          icon={
            expanded ? (
              <FolderOpen className="w-4 h-4 shrink-0 text-primary" />
            ) : (
              <Folder className="w-4 h-4 shrink-0" />
            )
          }
          label={domain.name}
          addTitle="New Entity"
          onToggle={() => toggle(key)}
          onNavigate={() => {
            setExpanded(key, true);
            router.push(base);
          }}
          onAdd={() =>
            router.push(
              assetHref({
                kind: "newEntity",
                domainSlug: domain.slug,
                productSlug: domain.products[0]?.slug ?? "default",
              })
            )
          }
        />

        {expanded && (
          <div className="ml-3 border-l border-border/50 pl-1 py-0.5">
            {domain.counts.dataTypes > 0 && (
              <SidebarLeafCategory
                testId={`domain-${domain.id}-data-types`}
                active={pathname === base && isDataTypesTab(activeTab)}
                count={domain.counts.dataTypes}
                icon={<Hash className="w-3 h-3 shrink-0" />}
                label="Data Types"
                onClick={() =>
                  router.push(
                    assetHref({ kind: "dataTypes", domainSlug: domain.slug, productSlug: null })
                  )
                }
              />
            )}

            {domain.counts.apis > 0 && (
              <SidebarLeafCategory
                testId={`domain-${domain.id}-apis`}
                active={pathname === base && activeTab === "apis"}
                count={domain.counts.apis}
                icon={<Globe className="w-3 h-3 shrink-0" />}
                label="APIs"
                onClick={() =>
                  router.push(assetHref({ kind: "apis", domainSlug: domain.slug, productSlug: null }))
                }
              />
            )}

            {domain.products.map((product) => renderProduct(domain, product))}
          </div>
        )}
      </div>
    );
  }

  function renderEnterprise() {
    const expanded = isExpanded(ENTERPRISE_KEY);
    const entitiesExpanded = isExpanded(ENTERPRISE_ENTITIES_KEY);
    const inRoute = isWithin(pathname, enterpriseHref);

    return (
      <div className="mb-1">
        <SidebarNodeRow
          testId="enterprise"
          active={pathname === enterpriseHref}
          inRoute={inRoute}
          expanded={expanded}
          icon={<Building2 className={cn("w-4 h-4 shrink-0", expanded && "text-primary")} />}
          label="Enterprise"
          addTitle="New Entity"
          onToggle={() => toggle(ENTERPRISE_KEY)}
          onNavigate={() => {
            setExpanded(ENTERPRISE_KEY, true);
            router.push(enterpriseHref);
          }}
          onAdd={() =>
            router.push(assetHref({ kind: "newEntity", domainSlug: null, productSlug: null }))
          }
        />

        {expanded && (
          <div className="ml-3 border-l border-border/50 pl-1 py-0.5">
            {enterpriseDataTypes > 0 && (
              <SidebarLeafCategory
                testId="enterprise-data-types"
                active={pathname === enterpriseHref && isDataTypesTab(activeTab)}
                count={enterpriseDataTypes}
                icon={<Hash className="w-3 h-3 shrink-0" />}
                label="Data Types"
                onClick={() =>
                  router.push(assetHref({ kind: "dataTypes", domainSlug: null, productSlug: null }))
                }
              />
            )}

            {enterpriseEntities.length > 0 && (
              <>
                <SidebarCategory
                  testId="enterprise-entities"
                  active={inRoute && !activeTab}
                  count={enterpriseEntities.length}
                  expanded={entitiesExpanded}
                  icon={<Database className="w-3 h-3 shrink-0" />}
                  label="Entities"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(ENTERPRISE_ENTITIES_KEY);
                    router.push(enterpriseHref);
                  }}
                />
                {entitiesExpanded && renderEntities(enterpriseEntities, null, null)}
              </>
            )}
          </div>
        )}
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
        ) : (
          <>
            {renderEnterprise()}
            {filteredDomains.length === 0 ? (
              <SidebarEmptyState hasSearch={Boolean(query)} />
            ) : (
              filteredDomains.map(renderDomain)
            )}
          </>
        )}
      </div>

      <ResizeHandle onMouseDown={onMouseDown} onDoubleClick={onDoubleClick} />
    </div>
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
