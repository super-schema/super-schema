"use client";

import { useState, useMemo, useEffect, useSyncExternalStore, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Plus,
  LayoutGrid,
  List,
  Trash2,
  Pencil,
} from "lucide-react";
import { EntityIcon, DataTypeIcon, ApiIcon, EventIcon } from "@/components/icons/feature-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { EntityCard } from "@/components/custom/EntityCard";
import { deleteEntityAction } from "./actions";
import { CreateDropdown } from "./components/CreateDropdown";
import { DomainTypesTab, type DomainTypeCreateIntent, type InheritedDataTypes, type SharedEnumData, type CustomScalarData, type UnionTypeData } from "./components/DomainTypesTab";
import { DomainApisTab, type DomainApiCreateIntent, type InheritedServices, type ServiceData } from "./components/DomainApisTab";
import { ProductContacts, type ProductContactsValue } from "./components/ProductContacts";
import { EditProductContactsDialog } from "./components/EditProductContactsDialog";
import { EventsList } from "@/features/events/workspace/EventsList";
import { NewEventDialog } from "@/features/events/workspace/NewEventDialog";
import type { EventListItem } from "@/features/events/event-page/load-events-list";
import { assetHref } from "@/lib/navigation/asset-href";
import { formatDateOnly } from "@/lib/date-format";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";

export type DomainTab = "entities" | "data-types" | "apis" | "events";

/**
 * Normalize the `?tab=` query value to a workspace tab. The legacy `types`
 * value is aliased to `data-types`, and the retired product `traits` tab to
 * `events` (traits now live inside each event); anything unknown falls back
 * to `entities`.
 */
export function normalizeWorkspaceTab(raw: string | null): DomainTab {
  if (raw === "types") return "data-types";
  if (raw === "traits") return "events";
  if (raw === "data-types" || raw === "apis" || raw === "entities" || raw === "events") return raw;
  return "entities";
}

const tabDomId = (id: DomainTab) => `product-tab-${id}`;
const PANEL_DOM_ID = "product-tabpanel";

const domainTabs: { icon: React.ComponentType<{ className?: string }>; label: string; id: DomainTab }[] = [
  { icon: EntityIcon, label: "Entities", id: "entities" },
  { icon: EventIcon, label: "Events", id: "events" },
  { icon: ApiIcon, label: "APIs", id: "apis" },
  { icon: DataTypeIcon, label: "Data Types", id: "data-types" },
];

interface EntityData {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  version: number;
  fieldCount: number;
  updatedAt: Date;
  classifications: { NEVER_STORED: number; PII: number; SENSITIVE: number; INTERNAL: number; PUBLIC: number } & Record<string, number>;
}

interface DomainWorkspaceProps {
  domainId: string;
  domainName: string;
  domainSlug: string;
  productId: string;
  productSlug: string;
  productName: string;
  domainDescription: string;
  domainPolicy: Record<string, unknown> | null;
  entities: EntityData[];
  /** Product-level data types (managed here). */
  sharedEnums: SharedEnumData[];
  customScalars: CustomScalarData[];
  unionTypes: UnionTypeData[];
  /** Product-level API services (managed here). */
  services: ServiceData[];
  /** Data types owned by the domain / Enterprise, shown read-only. */
  inheritedDataTypes?: InheritedDataTypes[];
  /** Services owned by the domain, shown read-only. */
  inheritedServices?: InheritedServices[];
  /** The product's events (valid event documents only), for the flat Events list. */
  events?: EventListItem[];
  /** The product's Engineering Lead, Manager and team addresses, shown under the header when present. */
  productContacts?: ProductContactsValue;
}

/** What the Edit contacts dialog starts from when the page passes no contacts: a product without any. */
const NO_CONTACTS: ProductContactsValue = { engineeringLead: null, manager: null, teamEmails: [] };

const VIEW_MODE_STORAGE_KEY = "super-schema:view-mode";
const VIEW_MODE_CHANGE_EVENT = "super-schema:view-mode-change";

function getViewModeSnapshot(): "tile" | "list" {
  if (typeof window === "undefined") return "tile";
  const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  return stored === "list" ? "list" : "tile";
}

function subscribeToViewMode(callback: () => void) {
  if (typeof window === "undefined") return () => {};

  function handleStorage(event: StorageEvent) {
    if (event.key === VIEW_MODE_STORAGE_KEY) {
      callback();
    }
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener(VIEW_MODE_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(VIEW_MODE_CHANGE_EVENT, callback);
  };
}

export function DomainWorkspace({
  domainId,
  domainName,
  domainSlug,
  productId,
  productSlug,
  productName,
  domainDescription,
  entities,
  sharedEnums,
  customScalars,
  unionTypes,
  services,
  inheritedDataTypes,
  inheritedServices,
  events,
  productContacts,
}: DomainWorkspaceProps) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const [activeTab, setActiveTab] = useState<DomainTab>(normalizeWorkspaceTab(tabParam));

  // Follow external URL changes (sidebar leaf links, back/forward).
  useEffect(() => {
    setActiveTab(normalizeWorkspaceTab(tabParam));
  }, [tabParam]);

  // One New Event dialog, opened by the header menu and by the Events tab alike.
  const [newEventOpen, setNewEventOpen] = useState(false);
  // The Edit contacts dialog opens from the button beside the contacts.
  const [contactsOpen, setContactsOpen] = useState(false);

  function tabHref(tab: DomainTab) {
    if (tab === "data-types") return assetHref({ kind: "dataTypes", domainSlug, productSlug });
    if (tab === "apis") return assetHref({ kind: "apis", domainSlug, productSlug });
    if (tab === "events") return assetHref({ kind: "events", domainSlug, productSlug });
    return assetHref({ kind: "product", domainSlug, productSlug });
  }

  // Every tab switch writes the URL so the address bar and visible tab agree.
  // History API, not `router.replace`: Next syncs `useSearchParams` with it and
  // no server re-render is needed to switch a client tab.
  function selectTab(tab: DomainTab) {
    setActiveTab(tab);
    window.history.replaceState(null, "", tabHref(tab));
  }

  // Roving tabindex: arrows / Home / End move between tabs (same keys as the Events section tabs).
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % domainTabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + domainTabs.length) % domainTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = domainTabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(domainTabs[next].id);
    document.getElementById(tabDomId(domainTabs[next].id))?.focus();
  }
  const viewMode = useSyncExternalStore(
    subscribeToViewMode,
    getViewModeSnapshot,
    (): "tile" | "list" => "tile"
  );

  const newEntityHref = assetHref({ kind: "newEntity", domainSlug, productSlug });
  const productTarget = { level: "PRODUCT", productId } as const;

  // Listen for Cmd+N global shortcut to navigate to wizard
  useEffect(() => {
    function handleNewEntity() {
      router.push(newEntityHref);
    }
    document.addEventListener("super-schema:new-entity", handleNewEntity);
    return () =>
      document.removeEventListener("super-schema:new-entity", handleNewEntity);
  }, [router, newEntityHref]);

  const [typeCreateIntent, setTypeCreateIntent] = useState<DomainTypeCreateIntent | null>(null);
  const [apiCreateIntent, setApiCreateIntent] = useState<DomainApiCreateIntent | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string; type: string } | null>(null);
  const [isDeletingEntity, setIsDeletingEntity] = useState(false);
  const [sortField, setSortField] = useState<string>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleView(mode: "tile" | "list") {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    window.dispatchEvent(new CustomEvent(VIEW_MODE_CHANGE_EVENT));
  }

  function toggleSort(field: string) {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  const sortedEntities = useMemo(() => {
    return [...entities].sort((a, b) => {
      const av = a[sortField as keyof EntityData];
      const bv = b[sortField as keyof EntityData];
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [entities, sortField, sortDir]);

  async function handleDeleteEntity(id: string) {
    setIsDeletingEntity(true);
    try {
      const result = await deleteEntityAction(id);
      if (result.error) {
        toast.error(result.error);
        return;
      }

      toast.success("Entity deleted");
      void invalidateDomainsTree();
      setDeleteConfirm(null);
      router.refresh();
    } catch {
      toast.error("Unable to delete the entity. Please try again.");
    } finally {
      setIsDeletingEntity(false);
    }
  }

  return (
    <div className="animate-auth-fade-up">
      {/* New Event dialog: a created event opens on its own page */}
      <NewEventDialog
        productId={productId}
        open={newEventOpen}
        onOpenChange={setNewEventOpen}
        onCreated={(id) => router.push(assetHref({ kind: "event", id, domainSlug, productSlug }))}
      />

      {/* Edit contacts dialog: starts from what is stored, saves only the three contact fields */}
      <EditProductContactsDialog
        productId={productId}
        productName={productName}
        contacts={productContacts ?? NO_CONTACTS}
        open={contactsOpen}
        onOpenChange={setContactsOpen}
      />

      {/* Entity delete confirmation dialog */}
      <Dialog
        open={deleteConfirm !== null}
        modal
        disablePointerDismissal={isDeletingEntity}
        onOpenChange={(open) => {
          if (!open && !isDeletingEntity) setDeleteConfirm(null);
        }}
      >
        {deleteConfirm ? (
          <DialogContent showCloseButton={!isDeletingEntity} data-testid="delete-entity-dialog">
            <DialogHeader>
              <DialogTitle>Delete &ldquo;{deleteConfirm.name}&rdquo;?</DialogTitle>
              <DialogDescription>
                This permanently deletes this {deleteConfirm.type} and all its data.
                This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={<Button variant="outline" size="sm" data-testid="delete-entity-cancel" />}
                disabled={isDeletingEntity}
              >
                Cancel
              </DialogClose>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleDeleteEntity(deleteConfirm.id)}
                disabled={isDeletingEntity}
                data-testid="delete-entity-confirm"
              >
                {isDeletingEntity ? "Deleting..." : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        <Link href="/schemas" className="hover:text-foreground transition-colors">
          Domains
        </Link>
        <ChevronRight className="w-3 h-3" />
        <Link
          href={assetHref({ kind: "domain", domainSlug })}
          className="hover:text-foreground transition-colors"
        >
          {domainName}
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">{productName}</span>
      </nav>

      {/* Header */}
      <div className="flex items-center justify-between mb-space-4">
        <div>
          <h1 className="text-display text-foreground">{domainName}</h1>
          {domainDescription && (
            <p className="text-body text-muted-foreground mt-space-1">{domainDescription}</p>
          )}
        </div>
        <div className="flex items-center gap-space-2">
          {/* Tile/List toggle */}
          <div className="flex items-center border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => toggleView("tile")}
              className={`p-1.5 transition-colors ${viewMode === "tile" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              title="Tile view"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => toggleView("list")}
              className={`p-1.5 transition-colors ${viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              title="List view"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
          <CreateDropdown
            onNewEntity={() => router.push(newEntityHref)}
            onNewCustomDataType={() => { selectTab("data-types"); setTypeCreateIntent("choose"); }}
            onNewApi={() => { selectTab("apis"); setApiCreateIntent("new"); }}
            onNewEvent={() => setNewEventOpen(true)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-x-space-6 gap-y-space-2 mb-space-4">
        <ProductContacts contacts={productContacts} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setContactsOpen(true)}
          data-testid="edit-product-contacts"
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
          Edit contacts
        </Button>
      </div>

      {/* Domain tabs */}
      <div role="tablist" aria-label={`${productName} sections`} className="flex items-center gap-space-1 border-b border-border mb-space-6">
        {domainTabs.map((tab, index) => (
          <button
            key={tab.id}
            id={tabDomId(tab.id)}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={PANEL_DOM_ID}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(e) => onTabKeyDown(e, index)}
            className={`flex items-center gap-space-2 px-space-4 py-space-2 text-body-small transition-colors border-b-2 ${
              activeTab === tab.id
                ? "border-primary text-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
            }`}
          >
            <tab.icon className="w-4 h-4" aria-hidden="true" />
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={PANEL_DOM_ID} aria-labelledby={tabDomId(activeTab)}>
      {/* Data Types tab */}
      {activeTab === "data-types" && (
        <DomainTypesTab
          domainId={domainId}
          target={productTarget}
          sharedEnums={sharedEnums}
          customScalars={customScalars}
          unionTypes={unionTypes}
          inherited={inheritedDataTypes}
          createIntent={typeCreateIntent}
          onCreateIntentConsumed={() => setTypeCreateIntent(null)}
        />
      )}

      {/* APIs tab */}
      {activeTab === "apis" && (
        <DomainApisTab
          domainId={domainId}
          target={productTarget}
          services={services}
          entities={entities.map((e) => ({ id: e.id, name: e.name }))}
          inherited={inheritedServices}
          createIntent={apiCreateIntent}
          onCreateIntentConsumed={() => setApiCreateIntent(null)}
        />
      )}

      {/* Events tab */}
      {activeTab === "events" && (
        <EventsList
          productId={productId}
          domainSlug={domainSlug}
          productSlug={productSlug}
          items={events ?? []}
          viewMode={viewMode}
          onCreate={() => setNewEventOpen(true)}
        />
      )}

      {/* Entity content */}
      {activeTab === "entities" && (sortedEntities.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <h2 className="text-heading-1 text-foreground mb-space-2">
            Create your first entity
          </h2>
          <p className="text-body text-muted-foreground mb-space-6 max-w-md">
            Define a logical entity in <strong>{domainName}</strong> to start building your schema.
          </p>
          {/* The same flow as the header's New Entity: the Create New Entity page offers every way to start. */}
          <Button onClick={() => router.push(newEntityHref)} className="gap-2" data-testid="entity-empty-create">
            <Plus className="w-4 h-4" aria-hidden="true" />
            New Entity
          </Button>
        </div>
      ) : viewMode === "tile" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-4">
          {sortedEntities.map((entity) => (
            <EntityCard
              key={entity.id}
              {...entity}
              domainName={domainName}
              domainSlug={domainSlug}
              productSlug={productSlug}
              onDelete={(id, name) => setDeleteConfirm({ id, name, type: "entity" })}
            />
          ))}
        </div>
      ) : (
        /* List view */
        <div className="surface-glass rounded-xl border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-caption text-muted-foreground">
                {[
                  { key: "name", label: "Name" },
                  { key: "version", label: "Version" },
                  { key: "status", label: "Status" },
                  { key: "fieldCount", label: "Fields" },
                  { key: "updatedAt", label: "Last Modified" },
                  { key: "actions", label: "" },
                ].map((col) => (
                  <th
                    key={col.key}
                    className="text-left px-space-4 py-space-3 font-medium cursor-pointer hover:text-foreground transition-colors"
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label}
                    {sortField === col.key && (
                      <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedEntities.map((entity) => (
                <tr
                  key={entity.id}
                  className="border-b border-border/50 hover:bg-accent/30 transition-colors cursor-pointer"
                  onClick={() => router.push(assetHref({ kind: "entity", slug: entity.slug, domainSlug, productSlug }))}
                >
                  <td className="px-space-4 py-space-3 font-mono text-body-small text-foreground">
                    {entity.name}
                  </td>
                  <td className="px-space-4 py-space-3 text-body-small text-muted-foreground">
                    v{entity.version}
                  </td>
                  <td className="px-space-4 py-space-3">
                    <span className="flex items-center gap-space-2">
                      <span className={`w-2 h-2 rounded-full ${
                        entity.status === "ACTIVE" ? "bg-success" : entity.status === "DRAFT" ? "bg-warning" : "bg-muted-foreground"
                      }`} />
                      <span className="text-body-small">{entity.status}</span>
                    </span>
                  </td>
                  <td className="px-space-4 py-space-3 text-body-small text-muted-foreground">
                    {entity.fieldCount}
                  </td>
                  <td className="px-space-4 py-space-3 text-body-small text-muted-foreground">
                    {formatDateOnly(entity.updatedAt)}
                  </td>
                  <td className="px-space-4 py-space-3">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirm({ id: entity.id, name: entity.name, type: "entity" });
                      }}
                      className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      title={`Delete entity ${entity.name}`}
                      aria-label={`Delete entity ${entity.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      </div>

    </div>
  );
}
