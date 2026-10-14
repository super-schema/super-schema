"use client";

import { useState, useMemo, useEffect, useRef, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  ChevronDown,
  Plus,
  LayoutGrid,
  List,
  Database,
  Hash,
  Globe,
  Trash2,
  Tag,
  FileText,
  Sparkles,
  FilePlus2,
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
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import { getTypeInfo } from "@/lib/data-types";
import { createEntityWithFieldsAction, deleteEntityAction, type CreateFieldInput } from "./actions";
import { deleteDomainAction } from "../actions";
import { useModKey } from "@/lib/platform";
import { DomainTypesTab, type DomainTypeCreateIntent, type SharedEnumData, type CustomScalarData, type UnionTypeData } from "./components/DomainTypesTab";
import type { DomainModelData } from "./components/DomainModelsTab";
import { DomainApisTab, type ServiceData } from "./components/DomainApisTab";
import { formatDateOnly } from "@/lib/date-format";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import type { DecoratorDefinitionData } from "./components/DomainDecoratorsTab";
import type { DomainDeletionImpact } from "@/types/domain-deletion";

export type DomainTab = "entities" | "data-types" | "apis";

/**
 * Normalize the `?tab=` query value to a workspace tab. The legacy `types`
 * value is aliased to `data-types`; anything unknown falls back to `entities`.
 */
export function normalizeWorkspaceTab(raw: string | null): DomainTab {
  if (raw === "types") return "data-types";
  if (raw === "data-types" || raw === "apis" || raw === "entities") return raw;
  return "entities";
}

// ---------------------------------------------------------------------------
// Create dropdown — New Entity, New Data Type (Enum / Scalar / Union), New API
// ---------------------------------------------------------------------------

function CreateDropdown({
  onNewEntity,
  onNewEnum,
  onNewScalar,
  onNewUnion,
  onNewApi,
}: {
  onNewEntity: () => void;
  onNewEnum: () => void;
  onNewScalar: () => void;
  onNewUnion: () => void;
  onNewApi: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mod = useModKey();

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  type DropdownItem = {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    action: () => void;
    description: string;
  };

  const entityItem: DropdownItem = {
    label: "New Entity",
    icon: Database,
    action: onNewEntity,
    description: "Schema entity with fields",
  };
  const dataTypeItems: DropdownItem[] = [
    { label: "Enum", icon: Hash, action: onNewEnum, description: "Shared enum type" },
    { label: "Scalar", icon: Hash, action: onNewScalar, description: "Custom scalar type" },
    { label: "Union", icon: Hash, action: onNewUnion, description: "Union type (A | B)" },
  ];
  const apiItem: DropdownItem = {
    label: "New API",
    icon: Globe,
    action: onNewApi,
    description: "API service definition",
  };

  function renderItem(item: DropdownItem, indented = false) {
    return (
      <button
        key={item.label}
        onClick={() => { item.action(); setOpen(false); }}
        className={`flex items-start gap-2 w-full text-left py-2 pr-3 hover:bg-accent transition-colors ${indented ? "pl-6" : "pl-3"}`}
      >
        <item.icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
        <div>
          <div className="text-body-small text-foreground">{item.label}</div>
          <div className="text-[10px] text-muted-foreground">{item.description}</div>
        </div>
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <div className="flex">
        <Button onClick={onNewEntity} className="gap-2 rounded-r-none" title={`New Entity (${mod}+N)`}>
          <Plus className="w-4 h-4" />
          New Entity
        </Button>
        <Button
          onClick={() => setOpen(!open)}
          className="px-1.5 rounded-l-none border-l border-primary-foreground/20"
          title="More options"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </Button>
      </div>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[220px]">
          {renderItem(entityItem)}
          <div className="text-[10px] uppercase text-muted-foreground px-3 pt-2">New Data Type</div>
          {dataTypeItems.map((item) => renderItem(item, true))}
          {renderItem(apiItem)}
        </div>
      )}
    </div>
  );
}

const domainTabs: { icon: React.ComponentType<{ className?: string }>; label: string; id: DomainTab }[] = [
  { icon: Database, label: "Entities", id: "entities" },
  { icon: Hash, label: "Data Types", id: "data-types" },
  { icon: Globe, label: "APIs", id: "apis" },
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
  classifications: { NEVER_STORED: number; PII: number; SENSITIVE: number; INTERNAL: number; PUBLIC: number };
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
  canDeleteDomain?: boolean;
  deletionImpact: DomainDeletionImpact;
  domainPolicy: Record<string, unknown> | null;
  entities: EntityData[];
  models: DomainModelData[];
  sharedEnums: SharedEnumData[];
  customScalars: CustomScalarData[];
  unionTypes: UnionTypeData[];
  decoratorDefinitions: DecoratorDefinitionData[];
  services: ServiceData[];
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
}: DomainWorkspaceProps) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<DomainTab>(
    normalizeWorkspaceTab(searchParams.get("tab"))
  );
  const viewMode = useSyncExternalStore(
    subscribeToViewMode,
    getViewModeSnapshot,
    () => "tile"
  );
  const [showCreate, setShowCreate] = useState(false);

  // Listen for Cmd+N global shortcut to navigate to wizard
  useEffect(() => {
    function handleNewEntity() {
      router.push(`/schemas/${domainSlug}/${productSlug}/new`);
    }
    document.addEventListener("super-schema:new-entity", handleNewEntity);
    return () =>
      document.removeEventListener("super-schema:new-entity", handleNewEntity);
  }, [router, domainSlug]);

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

  return (
    <div className="animate-auth-fade-up">
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
      <nav className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        <Link href="/schemas" className="hover:text-foreground transition-colors">
          Domains
        </Link>
        <ChevronRight className="w-3 h-3" />
        <Link
          href={`/schemas/${domainSlug}`}
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
            onNewEntity={() => router.push(`/schemas/${domainSlug}/${productSlug}/new`)}
            onNewEnum={() => { setActiveTab("data-types"); setTypeCreateIntent("enum"); }}
            onNewScalar={() => { setActiveTab("data-types"); setTypeCreateIntent("scalar"); }}
            onNewUnion={() => { setActiveTab("data-types"); setTypeCreateIntent("union"); }}
            onNewApi={() => setActiveTab("apis")}
          />
          {canDeleteDomain && !isSystemDomain ? (
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

      {/* Domain tabs */}
      <div className="flex items-center gap-space-1 border-b border-border mb-space-6">
        {domainTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-space-2 px-space-4 py-space-2 text-body-small transition-colors border-b-2 ${
              activeTab === tab.id
                ? "border-primary text-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Data Types tab */}
      {activeTab === "data-types" && (
        <DomainTypesTab
          domainId={domainId}
          target={{ level: "DOMAIN", domainId }}
          sharedEnums={sharedEnums}
          customScalars={customScalars}
          unionTypes={unionTypes}
          createIntent={typeCreateIntent}
          onCreateIntentConsumed={() => setTypeCreateIntent(null)}
        />
      )}

      {/* APIs tab */}
      {activeTab === "apis" && (
        <DomainApisTab
          domainId={domainId}
          target={{ level: "DOMAIN", domainId }}
          services={services}
          entities={entities.map((e) => ({ id: e.id, name: e.name }))}
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
                              variant={field.classification.toLowerCase() as "pii" | "sensitive" | "internal" | "public"}
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
              onClick={() => router.push(`/schemas/${domainSlug}/${productSlug}/new?template=standards`)}
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
              onClick={() => router.push(`/schemas/${domainSlug}/${productSlug}/new?mode=ai`)}
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
              onClick={() => router.push(`/schemas/${domainSlug}/${productSlug}/new`)}
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
                  onClick={() => router.push(`/schemas/${domainSlug}/${productSlug}/${entity.slug}`)}
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
  );
}
