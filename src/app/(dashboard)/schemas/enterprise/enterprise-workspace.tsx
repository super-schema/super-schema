"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Database, FilePlus2, Hash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EntityCard } from "@/components/custom/EntityCard";
import { assetHref } from "@/lib/navigation/asset-href";
import { levelLabel } from "@/lib/levels";
import { CreateDropdown } from "../[domainSlug]/components/CreateDropdown";
import {
  DomainTypesTab,
  type CustomScalarData,
  type DomainTypeCreateIntent,
  type SharedEnumData,
  type UnionTypeData,
} from "../[domainSlug]/components/DomainTypesTab";

export type EnterpriseTab = "entities" | "data-types";

/**
 * Normalize the `?tab=` query value to an Enterprise tab. The legacy `types` value
 * is aliased to `data-types`; a missing or unknown value falls back to `fallback`
 * (Entities when any Enterprise entity exists, otherwise Data Types).
 */
export function normalizeEnterpriseTab(raw: string | null, fallback: EnterpriseTab): EnterpriseTab {
  if (raw === "types") return "data-types";
  if (raw === "data-types" || raw === "entities") return raw;
  return fallback;
}

const TABS: { id: EnterpriseTab; label: string; icon: typeof Database }[] = [
  { id: "entities", label: "Entities", icon: Database },
  { id: "data-types", label: "Data Types", icon: Hash },
];

function tabDomId(id: EnterpriseTab) {
  return `enterprise-tab-${id}`;
}

function panelDomId(id: EnterpriseTab) {
  return `enterprise-tabpanel-${id}`;
}

/** Every tab writes an explicit `?tab=` so the URL never depends on the default. */
function tabHref(tab: EnterpriseTab) {
  return tab === "data-types"
    ? assetHref({ kind: "dataTypes", domainSlug: null, productSlug: null })
    : assetHref({ kind: "enterprise" }, { query: { tab: "entities" } });
}

export interface EnterpriseEntityRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  version: number;
  fieldCount: number;
  updatedAt: Date;
  classifications: { NEVER_STORED: number; PII: number; SENSITIVE: number; INTERNAL: number; PUBLIC: number };
}

export interface EnterpriseWorkspaceProps {
  tenantId: string;
  /** Tenant-level entities (no domain, no product). */
  entities: EnterpriseEntityRow[];
  /** Tenant-level data types (managed here). */
  dataTypes: {
    sharedEnums: SharedEnumData[];
    customScalars: CustomScalarData[];
    unionTypes: UnionTypeData[];
  };
}

export function EnterpriseWorkspace({ tenantId, entities, dataTypes }: EnterpriseWorkspaceProps) {
  const router = useRouter();
  const tabParam = useSearchParams().get("tab");
  const defaultTab: EnterpriseTab = entities.length > 0 ? "entities" : "data-types";
  const [activeTab, setActiveTab] = useState<EnterpriseTab>(normalizeEnterpriseTab(tabParam, defaultTab));
  const [typeCreateIntent, setTypeCreateIntent] = useState<DomainTypeCreateIntent | null>(null);

  // Follow external URL changes (sidebar links, back/forward).
  useEffect(() => {
    setActiveTab(normalizeEnterpriseTab(tabParam, defaultTab));
  }, [tabParam, defaultTab]);

  function selectTab(tab: EnterpriseTab) {
    setActiveTab(tab);
    router.replace(tabHref(tab), { scroll: false });
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

  const newEntityHref = assetHref({ kind: "newEntity", domainSlug: null, productSlug: null });
  const label = levelLabel("TENANT");

  return (
    <div className="animate-auth-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between mb-space-4">
        <div>
          <h1 className="text-display text-foreground">{label}</h1>
          <p className="text-body text-muted-foreground mt-space-1">
            Entities and data types shared across every domain.
          </p>
        </div>
        <CreateDropdown
          onNewEntity={() => router.push(newEntityHref)}
          onNewCustomDataType={() => {
            selectTab("data-types");
            setTypeCreateIntent("choose");
          }}
        />
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label={`${label} sections`}
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

      <div role="tabpanel" id={panelDomId(activeTab)} aria-labelledby={tabDomId(activeTab)}>
        {activeTab === "entities" &&
          (entities.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <h2 className="text-heading-1 text-foreground mb-space-2">No Enterprise entities yet</h2>
              <p className="text-body text-muted-foreground mb-space-6 max-w-md">
                An Enterprise entity is shared by every domain and product. Create one to define a
                common business object once.
              </p>
              <Button onClick={() => router.push(newEntityHref)} className="gap-2">
                <FilePlus2 className="w-4 h-4" />
                Create an Enterprise entity
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-4">
              {entities.map((entity) => (
                <EntityCard
                  key={entity.id}
                  {...entity}
                  domainName={label}
                  domainSlug={null}
                  productSlug={null}
                />
              ))}
            </div>
          ))}

        {activeTab === "data-types" && (
          <DomainTypesTab
            domainId={null}
            target={{ level: "TENANT", tenantId }}
            sharedEnums={dataTypes.sharedEnums}
            customScalars={dataTypes.customScalars}
            unionTypes={dataTypes.unionTypes}
            createIntent={typeCreateIntent}
            onCreateIntentConsumed={() => setTypeCreateIntent(null)}
          />
        )}
      </div>
    </div>
  );
}
