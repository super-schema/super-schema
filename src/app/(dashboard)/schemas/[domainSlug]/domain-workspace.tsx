"use client";

import { useState, useMemo, useEffect, useSyncExternalStore, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Plus,
  LayoutGrid,
  List,
  Database,
  Hash,
  Globe,
  Radio,
  Trash2,
  Tag,
  FileText,
  Sparkles,
  FilePlus2,
  Pencil,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EntityCard } from "@/components/custom/EntityCard";
import { DomainDeletionDialog } from "@/components/custom/DomainDeletionDialog";
import { TypePicker } from "@/components/custom/TypePicker";
import { standardClassificationVariant } from "@/lib/classification-counts";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import { getTypeInfo } from "@/lib/data-types";
import { createEntityWithFieldsAction, deleteEntityAction, type CreateFieldInput } from "./actions";
import { deleteDomainAction } from "../actions";
import { CreateDropdown } from "./components/CreateDropdown";
import { DomainTypesTab, type DomainTypeCreateIntent, type InheritedDataTypes, type SharedEnumData, type CustomScalarData, type UnionTypeData } from "./components/DomainTypesTab";
import { DomainApisTab, type InheritedServices, type ServiceData } from "./components/DomainApisTab";
import { ProductContacts, type ProductContactsValue } from "./components/ProductContacts";
import { EditProductContactsDialog } from "./components/EditProductContactsDialog";
import { EventsList } from "@/features/events/workspace/EventsList";
import { NewEventDialog } from "@/features/events/workspace/NewEventDialog";
import type { EventListItem } from "@/features/events/event-page/load-events-list";
import { assetHref } from "@/lib/navigation/asset-href";
import { formatDateOnly } from "@/lib/date-format";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import type { DomainDeletionImpact } from "@/types/domain-deletion";

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
  { icon: Database, label: "Entities", id: "entities" },
  { icon: Hash, label: "Data Types", id: "data-types" },
  { icon: Globe, label: "APIs", id: "apis" },
  { icon: Radio, label: "Events", id: "events" },
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
  isSystemDomain?: boolean;
  /**
   * Domain deletion is only offered when this is true AND `deletionImpact` is
   * provided; callers that disable deletion can skip computing the impact.
   */
  canDeleteDomain?: boolean;
  deletionImpact?: DomainDeletionImpact;
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

interface InlineField {
  tempId: string;
  name: string;
  type: string;
  nullable: boolean;
  isKey: boolean;
  description: string;
  classification: string | null;
  precision: number | null;
  scale: number | null;
  aliases: string;
}

function needsPrecisionScale(typeId: string): boolean {
  const info = getTypeInfo(typeId);
  return !!info?.requiresPrecision || !!info?.requiresScale;
}

/** What the Edit contacts dialog starts from when the page passes no contacts: a product without any. */
const NO_CONTACTS: ProductContactsValue = { engineeringLead: null, manager: null, teamEmails: [] };

let nextTempId = 0;
function makeTempId() {
  return `temp-${++nextTempId}`;
}

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
  isSystemDomain = false,
  canDeleteDomain = false,
  deletionImpact,
  domainPolicy,
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
    () => "tile"
  );
  const [showCreate, setShowCreate] = useState(false);

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
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string; type: string } | null>(null);
  const [isDeletingEntity, setIsDeletingEntity] = useState(false);
  const [domainDeleteOpen, setDomainDeleteOpen] = useState(false);
  const [isDeletingDomain, setIsDeletingDomain] = useState(false);
  const [domainDeleteError, setDomainDeleteError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [sortField, setSortField] = useState<string>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Entity creation state
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [inlineFields, setInlineFields] = useState<InlineField[]>([]);

  // Add-field form state
  const [showFieldForm, setShowFieldForm] = useState(false);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState("string");
  const [newFieldDescription, setNewFieldDescription] = useState("");
  const [newFieldNullable, setNewFieldNullable] = useState(true);
  const [newFieldIsKey, setNewFieldIsKey] = useState(false);
  const [newFieldClassification, setNewFieldClassification] = useState<string | null>(null);
  const [newFieldPrecision, setNewFieldPrecision] = useState("");
  const [newFieldScale, setNewFieldScale] = useState("");
  const [newFieldAliases, setNewFieldAliases] = useState("");

  // Domain policy defaults
  const defaultClassification = (domainPolicy?.defaultClassification as string) ?? null;
  const defaultRetention = (domainPolicy?.defaultRetention as string) ?? "";

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

  function handleNewFieldKeyChange(checked: boolean) {
    setNewFieldIsKey(checked);
    if (checked) setNewFieldNullable(false);
  }

  function resetFieldForm() {
    setNewFieldName("");
    setNewFieldType("string");
    setNewFieldDescription("");
    setNewFieldNullable(true);
    setNewFieldIsKey(false);
    setNewFieldClassification(null);
    setNewFieldPrecision("");
    setNewFieldScale("");
    setNewFieldAliases("");
    setShowFieldForm(false);
  }

  function addInlineField() {
    if (!newFieldName.trim()) return;
    setInlineFields((prev) => [
      ...prev,
      {
        tempId: makeTempId(),
        name: newFieldName.trim(),
        type: newFieldType,
        nullable: newFieldNullable,
        isKey: newFieldIsKey,
        description: newFieldDescription,
        classification: newFieldClassification,
        precision: newFieldPrecision ? parseInt(newFieldPrecision, 10) : null,
        scale: newFieldScale ? parseInt(newFieldScale, 10) : null,
        aliases: newFieldAliases,
      },
    ]);
    resetFieldForm();
  }

  function removeInlineField(tempId: string) {
    setInlineFields((prev) => prev.filter((f) => f.tempId !== tempId));
  }

  function resetCreateForm() {
    setShowCreate(false);
    setCreateError(null);
    setCreateName("");
    setCreateDescription("");
    setInlineFields([]);
    resetFieldForm();
  }

  async function handleCreate() {
    if (!createName.trim()) {
      setCreateError("Entity name is required");
      return;
    }

    setCreateError(null);
    setIsCreating(true);

    const fields: CreateFieldInput[] = inlineFields.map((f) => {
      const aliases = f.aliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      const decorators: Record<string, unknown> = {};
      if (defaultRetention) {
        decorators.policy = { retention: defaultRetention };
      }
      return {
        name: f.name,
        type: f.type,
        nullable: f.nullable,
        isKey: f.isKey,
        description: f.description,
        classification: f.classification,
        precision: f.precision,
        scale: f.scale,
        ...(aliases.length > 0 && { aliases }),
        ...(Object.keys(decorators).length > 0 && { decorators }),
      };
    });

    const result = await createEntityWithFieldsAction(
      domainId,
      {
        name: createName.trim(),
        description: createDescription,
        fields,
      },
      productId
    );

    setIsCreating(false);

    if (result?.error) {
      setCreateError(result.error);
    } else {
      invalidateDomainsTree();
      resetCreateForm();
    }
  }

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

  async function handleDeleteDomain() {
    setDomainDeleteError(null);
    setIsDeletingDomain(true);
    try {
      const result = await deleteDomainAction(domainId);
      if (result.error) {
        setDomainDeleteError(result.error);
        return;
      }

      toast.success(`"${domainName}" deleted`);
      void invalidateDomainsTree();
      setDomainDeleteOpen(false);
      router.push("/schemas");
    } catch {
      setDomainDeleteError("Unable to delete the domain. Please try again.");
    } finally {
      setIsDeletingDomain(false);
    }
  }

  const deletionEnabled = canDeleteDomain && !isSystemDomain && deletionImpact !== undefined;

  return (
    <div className="animate-auth-fade-up">
      {deletionEnabled && (
        <DomainDeletionDialog
          open={domainDeleteOpen}
          domainName={domainName}
          impact={deletionImpact}
          isDeleting={isDeletingDomain}
          error={domainDeleteError}
          onOpenChange={(open) => {
            setDomainDeleteOpen(open);
            if (!open) setDomainDeleteError(null);
          }}
          onConfirm={handleDeleteDomain}
        />
      )}

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
          <DialogContent showCloseButton={!isDeletingEntity}>
            <DialogHeader>
              <DialogTitle>Delete &ldquo;{deleteConfirm.name}&rdquo;?</DialogTitle>
              <DialogDescription>
                This permanently deletes this {deleteConfirm.type} and all its data.
                This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={<Button variant="outline" size="sm" />}
                disabled={isDeletingEntity}
              >
                Cancel
              </DialogClose>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleDeleteEntity(deleteConfirm.id)}
                disabled={isDeletingEntity}
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
            onNewApi={() => selectTab("apis")}
            onNewEvent={() => setNewEventOpen(true)}
          />
          {deletionEnabled ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDomainDeleteError(null);
                setDomainDeleteOpen(true);
              }}
              className="gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/50"
              title="Delete domain"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </Button>
          ) : null}
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
        />
      )}

      {/* Events tab */}
      {activeTab === "events" && (
        <EventsList
          productId={productId}
          domainSlug={domainSlug}
          productSlug={productSlug}
          items={events ?? []}
          onCreate={() => setNewEventOpen(true)}
        />
      )}

      {/* Create Entity inline form */}
      {activeTab === "entities" && showCreate && (
        <div className="surface-glass rounded-xl border border-primary/20 p-space-6 mb-space-6">
          <h3 className="text-heading-2 text-foreground mb-space-4">Create New Entity</h3>

          {/* Entity info */}
          <div className="space-y-space-4 mb-space-6">
            <div>
              <label className="text-body-small text-foreground mb-space-1 block font-medium">
                Entity Name
              </label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g., Customer, Order, Transaction"
                required
                maxLength={128}
                autoFocus
                className="h-9 font-mono"
              />
            </div>
            <div>
              <label className="text-body-small text-foreground mb-space-1 block font-medium">
                Description
              </label>
              <Input
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="Brief description"
                className="h-9"
              />
            </div>
          </div>

          {/* Fields section */}
          <div className="mb-space-4">
            <label className="text-body-small text-foreground mb-space-2 block font-medium">
              Fields
              <span className="text-muted-foreground font-normal ml-1">(optional — add fields now or later)</span>
            </label>

            {/* Existing inline fields as cards */}
            {inlineFields.length > 0 && (
              <div className="space-y-1 mb-space-3">
                {inlineFields.map((field) => {
                  const aliases = field.aliases
                    .split(",")
                    .map((a) => a.trim())
                    .filter(Boolean);
                  return (
                    <div
                      key={field.tempId}
                      className="surface-glass rounded-lg border border-border/50 hover:border-border transition-colors group"
                    >
                      <div className="flex items-center gap-space-2 px-space-3 py-space-2">
                        {/* Name */}
                        <span className="font-mono text-body-small text-foreground min-w-0 max-w-[180px] truncate">
                          {field.name}
                        </span>

                        {/* Tags */}
                        <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
                          <Badge variant="secondary" className="text-[10px] h-4 px-1 font-mono">
                            {getTypeInfo(field.type)?.label ?? field.type}
                          </Badge>
                          {needsPrecisionScale(field.type) && (
                            <span className="text-caption text-muted-foreground font-mono">
                              ({field.precision ?? "?"},{field.scale ?? "?"})
                            </span>
                          )}
                          {field.isKey && (
                            <Badge variant="warning" className="text-[10px] h-4 px-1">KEY</Badge>
                          )}
                          {!field.nullable && !field.isKey && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1">NOT NULL</Badge>
                          )}
                          {field.classification && (
                            <Badge
                              variant={standardClassificationVariant(field.classification) ?? "secondary"}
                              className="text-[10px] h-4 px-1"
                            >
                              {field.classification}
                            </Badge>
                          )}
                          {aliases.map((a) => (
                            <Badge key={a} variant="secondary" className="text-[10px] h-4 px-1 font-mono">{a}</Badge>
                          ))}
                          {field.description && (
                            <span className="text-caption text-muted-foreground/60 truncate max-w-[200px]">
                              {field.description}
                            </span>
                          )}
                        </div>

                        {/* Delete */}
                        <button
                          onClick={() => removeInlineField(field.tempId)}
                          className="p-1 text-muted-foreground hover:text-destructive transition-colors rounded opacity-0 group-hover:opacity-100"
                          title="Remove field"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add field form */}
            {showFieldForm ? (
              <div className="rounded-lg border border-border/50 p-space-3 space-y-space-3 bg-accent/5">
                {/* Row 1: Name + Type */}
                <div className="flex items-center gap-space-3">
                  <div className="flex-1 min-w-0">
                    <label className="text-caption text-muted-foreground mb-1 block">Name</label>
                    <Input
                      value={newFieldName}
                      onChange={(e) => {
                        setNewFieldName(e.target.value);
                        if (e.target.value.trim() && !newFieldClassification && defaultClassification) {
                          setNewFieldClassification(defaultClassification);
                        }
                      }}
                      placeholder="field_name"
                      className="h-8 font-mono text-body-small"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newFieldName.trim()) addInlineField();
                        if (e.key === "Escape") resetFieldForm();
                      }}
                    />
                  </div>
                  <div className="w-[140px]">
                    <label className="text-caption text-muted-foreground mb-1 block">Type</label>
                    <TypePicker value={newFieldType} onChange={setNewFieldType} />
                  </div>
                  {needsPrecisionScale(newFieldType) && (
                    <>
                      <div className="w-[72px]">
                        <label className="text-caption text-muted-foreground mb-1 block">Precision</label>
                        <Input
                          type="number"
                          value={newFieldPrecision}
                          onChange={(e) => setNewFieldPrecision(e.target.value)}
                          className="h-8 text-body-small"
                          placeholder="18"
                        />
                      </div>
                      <div className="w-[72px]">
                        <label className="text-caption text-muted-foreground mb-1 block">Scale</label>
                        <Input
                          type="number"
                          value={newFieldScale}
                          onChange={(e) => setNewFieldScale(e.target.value)}
                          className="h-8 text-body-small"
                          placeholder="2"
                        />
                      </div>
                    </>
                  )}
                </div>

                {/* Row 2: Description */}
                <div>
                  <label className="text-caption text-muted-foreground mb-1 block">Description</label>
                  <Input
                    value={newFieldDescription}
                    onChange={(e) => setNewFieldDescription(e.target.value)}
                    placeholder="Brief description"
                    className="h-8 text-body-small"
                  />
                </div>

                {/* Row 3: Constraints */}
                <div className="flex items-center gap-space-4 flex-wrap">
                  <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={newFieldNullable}
                      onChange={(e) => setNewFieldNullable(e.target.checked)}
                      className="accent-primary"
                      disabled={newFieldIsKey}
                    />
                    Nullable
                    {newFieldIsKey && <span className="text-[10px] text-muted-foreground/50">(auto: key)</span>}
                  </label>
                  <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={newFieldIsKey}
                      onChange={(e) => handleNewFieldKeyChange(e.target.checked)}
                      className="accent-primary"
                    />
                    Primary Key
                  </label>
                  <div className="flex items-center gap-1.5">
                    <span className="text-caption text-muted-foreground">Classification</span>
                    <ClassificationPicker value={newFieldClassification} onChange={setNewFieldClassification} />
                  </div>
                </div>

                {/* Row 4: Aliases */}
                <div>
                  <label className="text-caption text-muted-foreground mb-1 block">
                    Aliases <span className="text-muted-foreground/50">(comma-separated)</span>
                  </label>
                  <Input
                    value={newFieldAliases}
                    onChange={(e) => setNewFieldAliases(e.target.value)}
                    placeholder="alt_name, other_name"
                    className="h-8 text-body-small font-mono"
                  />
                </div>

                {/* Policy hint */}
                {defaultRetention && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Tag className="w-3.5 h-3.5 text-muted-foreground/50" />
                    <span className="text-caption text-muted-foreground/50">
                      Domain policy: retention {defaultRetention}
                    </span>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-space-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addInlineField}
                    disabled={!newFieldName.trim()}
                    className="gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Field
                  </Button>
                  <Button size="sm" variant="ghost" onClick={resetFieldForm}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowFieldForm(true)}
                className="w-full flex items-center justify-center gap-2 py-space-2 rounded-lg border border-dashed border-border hover:border-primary/40 hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors text-caption"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Field
              </button>
            )}
          </div>

          {createError && <p className="text-body-small text-destructive mb-space-4">{createError}</p>}
          <div className="flex gap-space-2">
            <Button onClick={handleCreate} disabled={isCreating}>
              {isCreating ? "Creating..." : "Create Entity"}
            </Button>
            <Button type="button" variant="outline" onClick={resetCreateForm}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Entity content */}
      {activeTab === "entities" && (sortedEntities.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <h2 className="text-heading-1 text-foreground mb-space-2">
            Create your first entity
          </h2>
          <p className="text-body text-muted-foreground mb-space-6 max-w-md">
            Define a logical entity in <strong>{domainName}</strong> to start building your schema. Choose how you want to get started:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-4 w-full max-w-2xl">
            {/* Standards Template */}
            <button
              onClick={() => router.push(assetHref({ kind: "newEntity", domainSlug, productSlug }, { query: { template: "standards" } }))}
              className="surface-glass rounded-xl border border-border/50 hover:border-primary/40 p-space-5 text-left transition-all hover:shadow-md group"
            >
              <FileText className="w-8 h-8 text-primary mb-space-3 group-hover:scale-110 transition-transform" />
              <h3 className="text-body font-medium text-foreground mb-space-1">Standards Template</h3>
              <p className="text-caption text-muted-foreground">
                Start from a pre-built template with common fields and best practices.
              </p>
            </button>

            {/* Describe with AI */}
            <button
              onClick={() => router.push(assetHref({ kind: "newEntity", domainSlug, productSlug }, { query: { mode: "ai" } }))}
              className="surface-glass rounded-xl border border-border/50 hover:border-primary/40 p-space-5 text-left transition-all hover:shadow-md group"
            >
              <Sparkles className="w-8 h-8 text-warning mb-space-3 group-hover:scale-110 transition-transform" />
              <h3 className="text-body font-medium text-foreground mb-space-1">Describe with AI</h3>
              <p className="text-caption text-muted-foreground">
                Describe your entity in plain language and let AI generate the schema.
              </p>
            </button>

            {/* Start Blank */}
            <button
              onClick={() => router.push(newEntityHref)}
              className="surface-glass rounded-xl border border-border/50 hover:border-primary/40 p-space-5 text-left transition-all hover:shadow-md group"
            >
              <FilePlus2 className="w-8 h-8 text-muted-foreground mb-space-3 group-hover:text-foreground group-hover:scale-110 transition-all" />
              <h3 className="text-body font-medium text-foreground mb-space-1">Start Blank</h3>
              <p className="text-caption text-muted-foreground">
                Create an empty entity and add fields manually from scratch.
              </p>
            </button>
          </div>
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
