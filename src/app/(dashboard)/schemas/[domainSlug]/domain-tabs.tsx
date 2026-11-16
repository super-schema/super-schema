"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronRight, Package, Puzzle } from "lucide-react";
import { DataTypeIcon, ApiIcon } from "@/components/icons/feature-icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { assetHref } from "@/lib/navigation/asset-href";
import { PROPERTIES_TAB_LABEL } from "@/features/events/builder/labels";
import { TraitsTab } from "@/features/events/workspace/TraitsTab";
import { EMPTY_TRAITS_TAB, type TraitsTabData } from "@/features/events/workspace/types";
import { ProductGrid, type ProductGridItem, type TierOption } from "./product-grid";
import {
  DomainTypesTab,
  type CustomScalarData,
  type InheritedDataTypes,
  type SharedEnumData,
  type UnionTypeData,
} from "./components/DomainTypesTab";
import { DomainApisTab, type ServiceData } from "./components/DomainApisTab";

export type DomainPageTab = "products" | "data-types" | "apis" | "traits";

/**
 * Normalize the `?tab=` query value to a domain page tab. The legacy `types`
 * value is aliased to `data-types`; anything unknown falls back to `products`.
 */
export function normalizeDomainTab(raw: string | null): DomainPageTab {
  if (raw === "types") return "data-types";
  if (raw === "data-types" || raw === "apis" || raw === "products" || raw === "traits") return raw;
  return "products";
}

const TABS: { id: DomainPageTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "products", label: "Products", icon: Package },
  { id: "data-types", label: "Data Types", icon: DataTypeIcon },
  { id: "apis", label: "APIs", icon: ApiIcon },
  { id: "traits", label: PROPERTIES_TAB_LABEL, icon: Puzzle },
];

function tabDomId(id: DomainPageTab) {
  return `domain-tab-${id}`;
}

/** TabsContent sets `text-sm`; the old panel inherited the page size. */
const PANEL_CLASS = "text-[length:inherit]";

export interface DomainTabsProps {
  domain: { id: string; name: string; slug: string; description: string };
  /** Everything ProductGrid needs besides the domain identity. */
  productGridProps: { products: ProductGridItem[]; tiers: TierOption[] };
  /** Domain-level data types (managed here). */
  dataTypes: {
    sharedEnums: SharedEnumData[];
    customScalars: CustomScalarData[];
    unionTypes: UnionTypeData[];
  };
  /** Data types owned by a broader level (e.g. Enterprise), shown read-only. */
  inheritedDataTypes?: InheritedDataTypes[];
  /** Domain-level API services. */
  services: ServiceData[];
  /** Domain traits + read-only Enterprise traits. */
  traits?: TraitsTabData;
}

export function DomainTabs({
  domain,
  productGridProps,
  dataTypes,
  inheritedDataTypes,
  services,
  traits,
}: DomainTabsProps) {
  const tabParam = useSearchParams().get("tab");
  const [activeTab, setActiveTab] = useState<DomainPageTab>(normalizeDomainTab(tabParam));

  // Follow external URL changes (sidebar links, back/forward).
  useEffect(() => {
    setActiveTab(normalizeDomainTab(tabParam));
  }, [tabParam]);

  function hrefFor(tab: DomainPageTab) {
    if (tab === "data-types") {
      return assetHref({ kind: "dataTypes", domainSlug: domain.slug, productSlug: null });
    }
    if (tab === "apis") {
      return assetHref({ kind: "apis", domainSlug: domain.slug, productSlug: null });
    }
    if (tab === "traits") {
      return assetHref({ kind: "traits", domainSlug: domain.slug, productSlug: null });
    }
    return assetHref({ kind: "domain", domainSlug: domain.slug });
  }

  // The tab is client state: write the URL with the History API (Next syncs
  // `useSearchParams` with it) instead of `router.replace`, which would
  // re-render the whole page on the server just to switch a tab.
  function selectTab(tab: DomainPageTab) {
    setActiveTab(tab);
    window.history.replaceState(null, "", hrefFor(tab));
  }

  const target = { level: "DOMAIN", domainId: domain.id } as const;

  return (
    <div className="animate-auth-fade-up">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        <Link href="/schemas" className="hover:text-foreground transition-colors">
          Domains
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">{domain.name}</span>
      </nav>

      {/* Header */}
      <div className="mb-space-4">
        <h1 className="text-display text-foreground">{domain.name}</h1>
        <p className="text-body text-muted-foreground mt-space-1">
          {domain.description || "Select a product to manage its schemas"}
        </p>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(value) => selectTab(value as DomainPageTab)} className="gap-0">
        <TabsList
          variant="line"
          activateOnFocus
          aria-label={`${domain.name} sections`}
          className="mb-space-6 w-full justify-start border-b border-border"
        >
          {TABS.map((tab) => (
            <TabsTrigger key={tab.id} id={tabDomId(tab.id)} value={tab.id} className="flex-none">
              <tab.icon className="w-4 h-4" aria-hidden="true" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="products" className={PANEL_CLASS}>
          <ProductGrid
            domainId={domain.id}
            domainName={domain.name}
            domainSlug={domain.slug}
            {...productGridProps}
          />
        </TabsContent>

        <TabsContent value="data-types" className={PANEL_CLASS}>
          <DomainTypesTab
            domainId={domain.id}
            target={target}
            sharedEnums={dataTypes.sharedEnums}
            customScalars={dataTypes.customScalars}
            unionTypes={dataTypes.unionTypes}
            inherited={inheritedDataTypes}
          />
        </TabsContent>

        <TabsContent value="apis" className={PANEL_CLASS}>
          <DomainApisTab
            domainId={domain.id}
            target={target}
            services={services}
            entities={[]}
          />
        </TabsContent>

        <TabsContent value="traits" className={PANEL_CLASS}>
          <TraitsTab target={target} domainSlug={domain.slug} data={traits ?? EMPTY_TRAITS_TAB} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
