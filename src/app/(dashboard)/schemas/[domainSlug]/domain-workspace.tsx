"use client";

import { useState, useMemo, useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import WorkflowIcon from "lucide-react/icons/workflow";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

const ProductDeploymentWorkflows = dynamic(() => import("@/components/custom/deployments/ProductDeploymentWorkflows").then((module) => module.ProductDeploymentWorkflows), { loading: () => <p role="status" className="text-sm text-muted-foreground">Loading workflows…</p> });

export type DomainTab = "entities" | "data-types" | "apis" | "events" | "workflows";

/**
 * Normalize the `?tab=` query value to a workspace tab. The legacy `types`
 * value is aliased to `data-types`, and the retired product `traits` tab to
 * `events` (traits now live inside each event); anything unknown falls back
 * to `entities`.
 */
export function normalizeWorkspaceTab(raw: string | null): DomainTab {
  if (raw === "types") return "data-types";
  if (raw === "traits") return "events";
  if (raw === "data-types" || raw === "apis" || raw === "entities" || raw === "events" || raw === "workflows") return raw;
  return "entities";
}

/** TabsContent sets `text-sm`; the old panel inherited the page size. */
const PANEL_CLASS = "text-[length:inherit]";
const tabDomId = (id: DomainTab) => `product-tab-${id}`;

const domainTabs: { icon: React.ComponentType<{ className?: string }>; label: string; id: DomainTab }[] = [
  { icon: EntityIcon, label: "Entities", id: "entities" },
  { icon: EventIcon, label: "Events", id: "events" },
  { icon: ApiIcon, label: "APIs", id: "apis" },
  { icon: DataTypeIcon, label: "Data Types", id: "data-types" },
  { icon: WorkflowIcon, label: "Workflows", id: "workflows" },
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
  productDescription: string;
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
  productDescription,
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
    // Browser history changes synchronize the local roving tab selection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab(normalizeWorkspaceTab(tabParam));
  }, [tabParam]);

  // One New Event dialog, opened by the header menu and by the Events tab alike.
  const [newEventOpen, setNewEventOpen] = useState(false);
  // The Edit contacts dialog opens from the button beside the contacts.
  const [contactsOpen, setContactsOpen] = useState(false);

  function tabHref(tab: DomainTab) {
    if (tab === "workflows") return assetHref({ kind: "product", domainSlug, productSlug }, { query: { tab: "workflows" } });
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
          <h1 className="text-display text-foreground">{productName}</h1>
          {productDescription && (
            <p className="text-body text-muted-foreground mt-space-1">{productDescription}</p>
          )}
        </div>
        <div className="flex items-center gap-space-2">
          {/* Tile/List toggle */}
          <div className="flex items-center border border-border rounded-lg overflow-hidden">
            <Button
              variant={viewMode === "tile" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => toggleView("tile")}
              title="Tile view"
              aria-label="Tile view"
              aria-pressed={viewMode === "tile"}
              className="rounded-none"
            >
              <LayoutGrid className="w-4 h-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => toggleView("list")}
              title="List view"
              aria-label="List view"
              aria-pressed={viewMode === "list"}
              className="rounded-none"
            >
              <List className="w-4 h-4" />
            </Button>
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
      <Tabs value={activeTab} onValueChange={(value) => selectTab(value as DomainTab)} className="gap-0">
        <TabsList
          variant="line"
          activateOnFocus
          aria-label={`${productName} sections`}
          className="mb-space-6 w-full justify-start border-b border-border"
        >
          {domainTabs.map((tab) => (
            <TabsTrigger key={tab.id} id={tabDomId(tab.id)} value={tab.id} className="flex-none">
              <tab.icon className="w-4 h-4" aria-hidden="true" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

      <TabsContent value="workflows" className={PANEL_CLASS}>
        <ProductDeploymentWorkflows productId={productId} />
      </TabsContent>
      {/* Data Types tab */}
      <TabsContent value="data-types" className={PANEL_CLASS}>
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
      </TabsContent>

      {/* APIs tab */}
      <TabsContent value="apis" className={PANEL_CLASS}>
        <DomainApisTab
          domainId={domainId}
          target={productTarget}
          services={services}
          entities={entities.map((e) => ({ id: e.id, name: e.name }))}
          inherited={inheritedServices}
          createIntent={apiCreateIntent}
          onCreateIntentConsumed={() => setApiCreateIntent(null)}
        />
      </TabsContent>

      {/* Events tab */}
      <TabsContent value="events" className={PANEL_CLASS}>
        <EventsList
          productId={productId}
          domainSlug={domainSlug}
          productSlug={productSlug}
          items={events ?? []}
          viewMode={viewMode}
          onCreate={() => setNewEventOpen(true)}
        />
      </TabsContent>

      {/* Entity content */}
      <TabsContent value="entities" className={PANEL_CLASS}>
      {sortedEntities.length === 0 ? (
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
          <Table>
            <TableHeader>
              <TableRow className="border-border text-caption text-muted-foreground hover:bg-transparent">
                {[
                  { key: "name", label: "Name" },
                  { key: "version", label: "Version" },
                  { key: "status", label: "Status" },
                  { key: "fieldCount", label: "Fields" },
                  { key: "updatedAt", label: "Last Modified" },
                  { key: "actions", label: "" },
                ].map((col) => (
                  <TableHead
                    key={col.key}
                    className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label}
                    {sortField === col.key && (
                      <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedEntities.map((entity) => (
                <TableRow
                  key={entity.id}
                  className="border-border/50 cursor-pointer"
                  onClick={() => router.push(assetHref({ kind: "entity", slug: entity.slug, domainSlug, productSlug }))}
                >
                  <TableCell className="font-mono text-body-small text-foreground">
                    {entity.name}
                  </TableCell>
                  <TableCell className="text-body-small text-muted-foreground">
                    v{entity.version}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-space-2">
                      <span className={`w-2 h-2 rounded-full ${
                        entity.status === "ACTIVE" ? "bg-success" : entity.status === "DRAFT" ? "bg-warning" : "bg-muted-foreground"
                      }`} />
                      <span className="text-body-small">{entity.status}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-body-small text-muted-foreground">
                    {entity.fieldCount}
                  </TableCell>
                  <TableCell className="text-body-small text-muted-foreground">
                    {formatDateOnly(entity.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirm({ id: entity.id, name: entity.name, type: "entity" });
                      }}
                      className="text-muted-foreground hover:text-destructive"
                      title={`Delete entity ${entity.name}`}
                      aria-label={`Delete entity ${entity.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      </TabsContent>
      </Tabs>

    </div>
  );
}
