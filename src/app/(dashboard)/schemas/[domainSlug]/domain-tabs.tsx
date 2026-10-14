"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Globe, Layers, Package } from "lucide-react";
import { assetHref } from "@/lib/navigation/asset-href";
import { ProductGrid, type ProductGridItem, type TierOption } from "./product-grid";
import {
  DomainTypesTab,
  type CustomScalarData,
  type InheritedDataTypes,
  type SharedEnumData,
  type UnionTypeData,
} from "./components/DomainTypesTab";
import { DomainApisTab, type ServiceData } from "./components/DomainApisTab";

export type DomainPageTab = "products" | "data-types" | "apis";

/**
 * Normalize the `?tab=` query value to a domain page tab. The legacy `types`
 * value is aliased to `data-types`; anything unknown falls back to `products`.
 */
export function normalizeDomainTab(raw: string | null): DomainPageTab {
  if (raw === "types") return "data-types";
  if (raw === "data-types" || raw === "apis" || raw === "products") return raw;
  return "products";
}

const TABS: { id: DomainPageTab; label: string; icon: typeof Package }[] = [
  { id: "products", label: "Products", icon: Package },
  { id: "data-types", label: "Data Types", icon: Layers },
  { id: "apis", label: "APIs", icon: Globe },
];

function tabDomId(id: DomainPageTab) {
  return `domain-tab-${id}`;
}

function panelDomId(id: DomainPageTab) {
  return `domain-tabpanel-${id}`;
}

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
}

export function DomainTabs({
  domain,
  productGridProps,
  dataTypes,
  inheritedDataTypes,
  services,
}: DomainTabsProps) {
  const router = useRouter();
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
    return assetHref({ kind: "domain", domainSlug: domain.slug });
  }

  function selectTab(tab: DomainPageTab) {
    setActiveTab(tab);
    router.replace(hrefFor(tab), { scroll: false });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(TABS[next].id);
    document.getElementById(tabDomId(TABS[next].id))?.focus();
  }

  const target = { level: "DOMAIN", domainId: domain.id } as const;

  return (
    <div className="animate-auth-fade-up">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
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
      <div
        role="tablist"
        aria-label={`${domain.name} sections`}
        className="flex items-center gap-space-1 border-b border-border mb-space-6"
      >
        {TABS.map((tab, index) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={tabDomId(tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelDomId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              className={`flex items-center gap-space-2 px-space-4 py-space-2 text-body-small border-b-2 -mb-px transition-colors ${
                selected
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
              }`}
            >
              <tab.icon className="w-4 h-4" aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={panelDomId(activeTab)}
        aria-labelledby={tabDomId(activeTab)}
      >
        {activeTab === "products" && (
          <ProductGrid
            domainId={domain.id}
            domainName={domain.name}
            domainSlug={domain.slug}
            {...productGridProps}
          />
        )}

        {activeTab === "data-types" && (
          <DomainTypesTab
            domainId={domain.id}
            target={target}
            sharedEnums={dataTypes.sharedEnums}
            customScalars={dataTypes.customScalars}
            unionTypes={dataTypes.unionTypes}
            inherited={inheritedDataTypes}
          />
        )}

        {activeTab === "apis" && (
          <DomainApisTab
            domainId={domain.id}
            target={target}
            services={services}
            entities={[]}
          />
        )}
      </div>
    </div>
  );
}
