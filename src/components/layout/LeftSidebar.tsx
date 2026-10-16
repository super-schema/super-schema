"use client";

import { Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  Database,
  Folder,
  FolderOpen,
  Globe,
  Hash,
  Package,
  Puzzle,
  Radio,
  RefreshCcw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDomainsTree } from "@/hooks/useDomainsTree";
import {
  EVENT_PAGE_SEGMENT,
  EVENT_SEGMENT,
  TRAITS_SEGMENT,
  assetHref,
} from "@/lib/navigation/asset-href";
import type {
  ExplorerDomain,
  ExplorerEntity,
  ExplorerProduct,
} from "@/lib/navigation/build-explorer-tree";
import {
  SidebarCategory,
  SidebarEntityRow,
  SidebarLeafCategory,
  SidebarNodeRow,
  type SidebarNavigate,
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

// Detail pages of the non-entity kinds (events, traits, and the old message / channel / spec
// routes that now redirect) live under the same level base as entity URLs; the Entities row
// must not light up for them.
const NON_ENTITY_SEGMENTS: readonly string[] = [EVENT_PAGE_SEGMENT, ...Object.values(EVENT_SEGMENT), TRAITS_SEGMENT];
function isNonEntityDetail(pathname: string, base: string) {
  return NON_ENTITY_SEGMENTS.some((segment) => isWithin(pathname, `${base}/${segment}`));
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
  const currentQuery = searchParams?.toString() ?? "";
  const currentUrl = currentQuery ? `${pathname}?${currentQuery}` : pathname;
  const [search, setSearch] = useState("");
  // Explicit user choices; anything absent falls back to the route-derived defaults.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // Toggles made while a search is active live apart so they never leak into
  // the browsing state; they reset when the query clears.
  const [searchOverrides, setSearchOverrides] = useState<Record<string, boolean>>({});
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

  const query = search.trim().toLowerCase();
  const searching = query !== "";

  // While searching, every node that survives the filter is expanded so the
  // matching entities are visible.
  const isExpanded = (key: string) =>
    searching ? (searchOverrides[key] ?? true) : (overrides[key] ?? defaultExpanded.has(key));

  // Row callbacks are stable across pathname changes (they read the live URL
  // through a ref and flip expansion via functional updates), so the memoized
  // rows are not re-rendered by navigation alone.
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // Layout effect, not a passive one: a click landing between a navigation's
  // commit and the passive-effect flush must still compare against the new URL.
  const currentUrlRef = useRef(currentUrl);
  useLayoutEffect(() => {
    currentUrlRef.current = currentUrl;
  }, [currentUrl]);
  const { push } = router;

  const expand = useCallback(
    (key: string) => {
      const apply = (prev: Record<string, boolean>) => ({ ...prev, [key]: true });
      if (searching) setSearchOverrides(apply);
      else setOverrides(apply);
    },
    [searching]
  );
  const toggle = useCallback(
    (key: string) => {
      const flip = (prev: Record<string, boolean>) => ({
        ...prev,
        [key]: !(prev[key] ?? (searching || defaultExpanded.has(key))),
      });
      if (searching) setSearchOverrides(flip);
      else setOverrides(flip);
    },
    [searching, defaultExpanded]
  );
  // Every navigation runs in a transition so the clicked row can show a pending
  // state, and never pushes the URL we are already on (it only expands).
  const navigate = useCallback<SidebarNavigate>(
    (href, expandKey) => {
      if (expandKey) expand(expandKey);
      if (href === currentUrlRef.current) return;
      setPendingHref(href);
      startTransition(() => {
        push(href);
      });
    },
    [expand, push]
  );
  const pendingTarget = isPending ? pendingHref : null;
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
  const enterpriseAddHref = assetHref({ kind: "newEntity", domainSlug: null, productSlug: null });
  const enterpriseDataTypesHref = assetHref({ kind: "dataTypes", domainSlug: null, productSlug: null });
  const enterpriseDataTypes = tree?.enterprise.counts.dataTypes ?? 0;
  const enterpriseTraitsHref = assetHref({ kind: "traits", domainSlug: null, productSlug: null });
  const enterpriseTraits = tree?.enterprise.counts.traits ?? 0;

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
          href={href}
          onNavigate={navigate}
          pending={pendingTarget === href}
        />
      );
    });
  }

  function renderProduct(domain: ExplorerDomain, product: ExplorerProduct) {
    const base = assetHref({ kind: "product", domainSlug: domain.slug, productSlug: product.slug });
    const addHref = assetHref({ kind: "newEntity", domainSlug: domain.slug, productSlug: product.slug });
    const dataTypesHref = assetHref({
      kind: "dataTypes",
      domainSlug: domain.slug,
      productSlug: product.slug,
    });
    const apisHref = assetHref({ kind: "apis", domainSlug: domain.slug, productSlug: product.slug });
    // One Events leaf: messages, channels and traits are parts of an event, not leaves of their own.
    const eventsHref = assetHref({ kind: "events", domainSlug: domain.slug, productSlug: product.slug });
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
          icon={Package}
          label={product.name}
          addTitle="New Entity"
          nodeKey={key}
          href={base}
          addHref={addHref}
          pending={pendingTarget === base || pendingTarget === addHref}
          onToggle={toggle}
          onNavigate={navigate}
        />

        {expanded && (
          <div className="ml-3 border-l border-border/50 pl-1 py-0.5">
            {product.entities.length > 0 && (
              <>
                <SidebarCategory
                  testId={`product-${product.id}-entities`}
                  active={inRoute && !activeTab && !isNonEntityDetail(pathname, base)}
                  count={product.entities.length}
                  expanded={entitiesExpanded}
                  icon={Database}
                  label="Entities"
                  nodeKey={entitiesKey}
                  href={base}
                  pending={pendingTarget === base}
                  onToggle={toggle}
                  onNavigate={navigate}
                />
                {entitiesExpanded && renderEntities(product.entities, domain.slug, product.slug)}
              </>
            )}

            {product.counts.dataTypes > 0 && (
              <SidebarLeafCategory
                testId={`product-${product.id}-data-types`}
                active={pathname === base && isDataTypesTab(activeTab)}
                count={product.counts.dataTypes}
                icon={Hash}
                label="Data Types"
                href={dataTypesHref}
                pending={pendingTarget === dataTypesHref}
                onNavigate={navigate}
              />
            )}

            {product.counts.apis > 0 && (
              <SidebarLeafCategory
                testId={`product-${product.id}-apis`}
                active={pathname === base && activeTab === "apis"}
                count={product.counts.apis}
                icon={Globe}
                label="APIs"
                href={apisHref}
                pending={pendingTarget === apisHref}
                onNavigate={navigate}
              />
            )}

            {product.counts.eventSpecs > 0 && (
              <SidebarLeafCategory
                testId={`product-${product.id}-events`}
                active={(pathname === base && activeTab === "events") || isWithin(pathname, `${base}/${EVENT_PAGE_SEGMENT}`)}
                count={product.counts.eventSpecs}
                icon={Radio}
                label="Events"
                href={eventsHref}
                pending={pendingTarget === eventsHref}
                onNavigate={navigate}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  function renderDomain(domain: ExplorerDomain) {
    const base = assetHref({ kind: "domain", domainSlug: domain.slug });
    // Entities live in products: "+" creates one in the first product. A domain with no
    // products has nowhere to put it, so "+" opens the domain's Products tab (its default tab).
    const firstProduct = domain.products[0];
    const addHref = firstProduct
      ? assetHref({ kind: "newEntity", domainSlug: domain.slug, productSlug: firstProduct.slug })
      : base;
    const addTitle = firstProduct ? "New Entity" : "Create a product first";
    const dataTypesHref = assetHref({ kind: "dataTypes", domainSlug: domain.slug, productSlug: null });
    const apisHref = assetHref({ kind: "apis", domainSlug: domain.slug, productSlug: null });
    const traitsHref = assetHref({ kind: "traits", domainSlug: domain.slug, productSlug: null });
    const key = domainKey(domain.id);
    const expanded = isExpanded(key);

    return (
      <div key={domain.id} className="mb-1">
        <SidebarNodeRow
          testId={`domain-${domain.id}`}
          active={pathname === base}
          inRoute={isWithin(pathname, base)}
          expanded={expanded}
          icon={Folder}
          expandedIcon={FolderOpen}
          label={domain.name}
          addTitle={addTitle}
          nodeKey={key}
          href={base}
          addHref={addHref}
          pending={pendingTarget === base || pendingTarget === addHref}
          onToggle={toggle}
          onNavigate={navigate}
        />

        {expanded && (
          <div className="ml-3 border-l border-border/50 pl-1 py-0.5">
            {domain.counts.dataTypes > 0 && (
              <SidebarLeafCategory
                testId={`domain-${domain.id}-data-types`}
                active={pathname === base && isDataTypesTab(activeTab)}
                count={domain.counts.dataTypes}
                icon={Hash}
                label="Data Types"
                href={dataTypesHref}
                pending={pendingTarget === dataTypesHref}
                onNavigate={navigate}
              />
            )}

            {domain.counts.apis > 0 && (
              <SidebarLeafCategory
                testId={`domain-${domain.id}-apis`}
                active={pathname === base && activeTab === "apis"}
                count={domain.counts.apis}
                icon={Globe}
                label="APIs"
                href={apisHref}
                pending={pendingTarget === apisHref}
                onNavigate={navigate}
              />
            )}

            {domain.counts.traits > 0 && (
              <SidebarLeafCategory
                testId={`domain-${domain.id}-traits`}
                active={(pathname === base && activeTab === "traits") || isWithin(pathname, `${base}/${TRAITS_SEGMENT}`)}
                count={domain.counts.traits}
                icon={Puzzle}
                label="Traits"
                href={traitsHref}
                pending={pendingTarget === traitsHref}
                onNavigate={navigate}
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
          icon={Building2}
          label="Enterprise"
          addTitle="New Entity"
          nodeKey={ENTERPRISE_KEY}
          href={enterpriseHref}
          addHref={enterpriseAddHref}
          pending={pendingTarget === enterpriseHref || pendingTarget === enterpriseAddHref}
          onToggle={toggle}
          onNavigate={navigate}
        />

        {expanded && (
          <div className="ml-3 border-l border-border/50 pl-1 py-0.5">
            {enterpriseDataTypes > 0 && (
              <SidebarLeafCategory
                testId="enterprise-data-types"
                active={pathname === enterpriseHref && isDataTypesTab(activeTab)}
                count={enterpriseDataTypes}
                icon={Hash}
                label="Data Types"
                href={enterpriseDataTypesHref}
                pending={pendingTarget === enterpriseDataTypesHref}
                onNavigate={navigate}
              />
            )}

            {enterpriseTraits > 0 && (
              <SidebarLeafCategory
                testId="enterprise-traits"
                active={
                  (pathname === enterpriseHref && activeTab === "traits") ||
                  isWithin(pathname, `${enterpriseHref}/${TRAITS_SEGMENT}`)
                }
                count={enterpriseTraits}
                icon={Puzzle}
                label="Traits"
                href={enterpriseTraitsHref}
                pending={pendingTarget === enterpriseTraitsHref}
                onNavigate={navigate}
              />
            )}

            {enterpriseEntities.length > 0 && (
              <>
                <SidebarCategory
                  testId="enterprise-entities"
                  active={inRoute && (!activeTab || activeTab === "entities") && !isNonEntityDetail(pathname, enterpriseHref)}
                  count={enterpriseEntities.length}
                  expanded={entitiesExpanded}
                  icon={Database}
                  label="Entities"
                  nodeKey={ENTERPRISE_ENTITIES_KEY}
                  href={enterpriseHref}
                  pending={pendingTarget === enterpriseHref}
                  onToggle={toggle}
                  onNavigate={navigate}
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
            onChange={(event) => {
              const value = event.target.value;
              if (!value.trim()) setSearchOverrides({});
              setSearch(value);
            }}
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
