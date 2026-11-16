"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FilePlus2, Puzzle } from "lucide-react";
import { EntityIcon, DataTypeIcon } from "@/components/icons/feature-icons";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EntityCard } from "@/components/custom/EntityCard";
import { assetHref } from "@/lib/navigation/asset-href";
import { PROPERTIES_TAB_LABEL } from "@/features/events/builder/labels";
import { TraitsTab } from "@/features/events/workspace/TraitsTab";
import { EMPTY_TRAITS_TAB, type TraitsTabData } from "@/features/events/workspace/types";
import { levelLabel } from "@/lib/levels";
import { CreateDropdown } from "../[domainSlug]/components/CreateDropdown";
import {
  DomainTypesTab,
  type CustomScalarData,
  type DomainTypeCreateIntent,
  type SharedEnumData,
  type UnionTypeData,
} from "../[domainSlug]/components/DomainTypesTab";

export type EnterpriseTab = "entities" | "data-types" | "traits";

/**
 * Normalize the `?tab=` query value to an Enterprise tab. The legacy `types` value
 * is aliased to `data-types`; a missing or unknown value falls back to `fallback`
 * (Entities when any Enterprise entity exists, otherwise Data Types).
 */
export function normalizeEnterpriseTab(raw: string | null, fallback: EnterpriseTab): EnterpriseTab {
  if (raw === "types") return "data-types";
  if (raw === "data-types" || raw === "entities" || raw === "traits") return raw;
  return fallback;
}

const TABS: { id: EnterpriseTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "entities", label: "Entities", icon: EntityIcon },
  { id: "data-types", label: "Data Types", icon: DataTypeIcon },
  { id: "traits", label: PROPERTIES_TAB_LABEL, icon: Puzzle },
];

function tabDomId(id: EnterpriseTab) {
  return `enterprise-tab-${id}`;
}

/** TabsContent sets `text-sm`; the old panel inherited the page size. */
const PANEL_CLASS = "text-[length:inherit]";

/** Every tab writes an explicit `?tab=` so the URL never depends on the default. */
function tabHref(tab: EnterpriseTab) {
  if (tab === "data-types") return assetHref({ kind: "dataTypes", domainSlug: null, productSlug: null });
  if (tab === "traits") return assetHref({ kind: "traits", domainSlug: null, productSlug: null });
  return assetHref({ kind: "enterprise" }, { query: { tab: "entities" } });
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
  /** Tenant-level traits (managed here). */
  traits?: TraitsTabData;
}

export function EnterpriseWorkspace({ tenantId, entities, dataTypes, traits }: EnterpriseWorkspaceProps) {
  const router = useRouter();
  const tabParam = useSearchParams().get("tab");
  const defaultTab: EnterpriseTab = entities.length > 0 ? "entities" : "data-types";
  const [activeTab, setActiveTab] = useState<EnterpriseTab>(normalizeEnterpriseTab(tabParam, defaultTab));
  const [typeCreateIntent, setTypeCreateIntent] = useState<DomainTypeCreateIntent | null>(null);
  const [traitCreateIntent, setTraitCreateIntent] = useState<"trait" | null>(null);
  const consumeTraitIntent = useCallback(() => setTraitCreateIntent(null), []);

  // Follow external URL changes (sidebar links, back/forward).
  useEffect(() => {
    setActiveTab(normalizeEnterpriseTab(tabParam, defaultTab));
  }, [tabParam, defaultTab]);

  // Client-only tab switch: the History API keeps `useSearchParams` in sync
  // without a server round trip (see DomainTabs).
  function selectTab(tab: EnterpriseTab) {
    setActiveTab(tab);
    window.history.replaceState(null, "", tabHref(tab));
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
            Entities, data types and message properties shared across every domain.
          </p>
        </div>
        <CreateDropdown
          onNewEntity={() => router.push(newEntityHref)}
          onNewCustomDataType={() => {
            selectTab("data-types");
            setTypeCreateIntent("choose");
          }}
          onNewTrait={() => {
            selectTab("traits");
            setTraitCreateIntent("trait");
          }}
        />
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(value) => selectTab(value as EnterpriseTab)} className="gap-0">
        <TabsList
          variant="line"
          activateOnFocus
          aria-label={`${label} sections`}
          className="mb-space-6 w-full justify-start border-b border-border"
        >
          {TABS.map((tab) => (
            <TabsTrigger key={tab.id} id={tabDomId(tab.id)} value={tab.id} className="flex-none">
              <tab.icon className="w-4 h-4" aria-hidden="true" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="entities" className={PANEL_CLASS}>
          {entities.length === 0 ? (
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
          )}
        </TabsContent>

        <TabsContent value="data-types" className={PANEL_CLASS}>
          <DomainTypesTab
            domainId={null}
            target={{ level: "TENANT", tenantId }}
            sharedEnums={dataTypes.sharedEnums}
            customScalars={dataTypes.customScalars}
            unionTypes={dataTypes.unionTypes}
            createIntent={typeCreateIntent}
            onCreateIntentConsumed={() => setTypeCreateIntent(null)}
          />
        </TabsContent>

        <TabsContent value="traits" className={PANEL_CLASS}>
          <TraitsTab
            target={{ level: "TENANT", tenantId }}
            domainSlug={null}
            data={traits ?? EMPTY_TRAITS_TAB}
            createIntent={traitCreateIntent}
            onCreateIntentConsumed={consumeTraitIntent}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
