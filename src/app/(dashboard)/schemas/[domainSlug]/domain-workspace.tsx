"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import {
  ChevronRight,
  Plus,
  LayoutGrid,
  List,
  Database,
  GitBranch,
  ShieldCheck,
  ClipboardCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntityCard } from "@/components/custom/EntityCard";
import { TypePicker } from "@/components/custom/TypePicker";
import { createEntityAction, createEntityWithFieldsAction, type CreateFieldInput } from "./actions";

const domainTabs = [
  { icon: Database, label: "Entities", id: "entities" },
  { icon: GitBranch, label: "Lineage", id: "lineage" },
  { icon: ShieldCheck, label: "Governance", id: "governance" },
  { icon: ClipboardCheck, label: "Compliance", id: "compliance" },
];

interface EntityData {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  fieldCount: number;
  updatedAt: Date;
  classifications: { PII: number; SENSITIVE: number; INTERNAL: number; PUBLIC: number };
}

interface DomainWorkspaceProps {
  domainId: string;
  domainName: string;
  domainSlug: string;
  domainDescription: string;
  entities: EntityData[];
}

interface InlineField {
  tempId: string;
  name: string;
  type: string;
  nullable: boolean;
  isKey: boolean;
}

let nextTempId = 0;
function makeTempId() {
  return `temp-${++nextTempId}`;
}

export function DomainWorkspace({
  domainId,
  domainName,
  domainSlug,
  domainDescription,
  entities,
}: DomainWorkspaceProps) {
  const [viewMode, setViewMode] = useState<"tile" | "list">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("super-schema:view-mode") as "tile" | "list") || "tile";
    }
    return "tile";
  });
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [sortField, setSortField] = useState<string>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Inline field creation state
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [inlineFields, setInlineFields] = useState<InlineField[]>([]);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState("string");

  function toggleView(mode: "tile" | "list") {
    setViewMode(mode);
    localStorage.setItem("super-schema:view-mode", mode);
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

  function addInlineField() {
    if (!newFieldName.trim()) return;
    setInlineFields((prev) => [
      ...prev,
      {
        tempId: makeTempId(),
        name: newFieldName.trim(),
        type: newFieldType,
        nullable: true,
        isKey: false,
      },
    ]);
    setNewFieldName("");
    setNewFieldType("string");
  }

  function removeInlineField(tempId: string) {
    setInlineFields((prev) => prev.filter((f) => f.tempId !== tempId));
  }

  function updateInlineField(tempId: string, updates: Partial<InlineField>) {
    setInlineFields((prev) =>
      prev.map((f) => (f.tempId === tempId ? { ...f, ...updates } : f))
    );
  }

  function resetCreateForm() {
    setShowCreate(false);
    setCreateError(null);
    setCreateName("");
    setCreateDescription("");
    setInlineFields([]);
    setNewFieldName("");
    setNewFieldType("string");
  }

  async function handleCreate() {
    if (!createName.trim()) {
      setCreateError("Entity name is required");
      return;
    }

    setCreateError(null);
    setIsCreating(true);

    const fields: CreateFieldInput[] = inlineFields.map((f) => ({
      name: f.name,
      type: f.type,
      nullable: f.nullable,
      isKey: f.isKey,
      description: "",
      classification: null,
      precision: null,
      scale: null,
    }));

    const result = await createEntityWithFieldsAction(domainId, {
      name: createName.trim(),
      description: createDescription,
      fields,
    });

    setIsCreating(false);

    if (result?.error) {
      setCreateError(result.error);
    } else {
      resetCreateForm();
    }
  }

  // Legacy formData handler kept for compatibility
  async function handleCreateLegacy(formData: FormData) {
    setCreateError(null);
    setIsCreating(true);
    const result = await createEntityAction(domainId, formData);
    setIsCreating(false);
    if (result?.error) {
      setCreateError(result.error);
    } else {
      setShowCreate(false);
    }
  }

  return (
    <div className="animate-auth-fade-up">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        <Link href="/schemas" className="hover:text-foreground transition-colors">
          Domains
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">{domainName}</span>
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
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            New Entity
          </Button>
        </div>
      </div>

      {/* Domain tabs */}
      <div className="flex items-center gap-space-1 border-b border-border mb-space-6">
        {domainTabs.map((tab) => (
          <button
            key={tab.id}
            className={`flex items-center gap-space-2 px-space-4 py-space-2 text-body-small transition-colors border-b-2 ${
              tab.id === "entities"
                ? "border-primary text-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Create Entity inline form */}
      {showCreate && (
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

          {/* Inline field grid */}
          <div className="mb-space-4">
            <label className="text-body-small text-foreground mb-space-2 block font-medium">
              Fields
              <span className="text-muted-foreground font-normal ml-1">(optional — add fields now or later)</span>
            </label>

            <div className="surface-glass rounded-lg border border-border overflow-hidden">
              {/* Field header */}
              {inlineFields.length > 0 && (
                <div className="grid grid-cols-[1fr_140px_64px_64px_40px] gap-0 border-b border-border text-caption text-muted-foreground font-medium">
                  <div className="px-space-3 py-space-2">Name</div>
                  <div className="px-space-3 py-space-2">Type</div>
                  <div className="px-space-3 py-space-2 text-center">Null</div>
                  <div className="px-space-3 py-space-2 text-center">Key</div>
                  <div className="px-space-2 py-space-2" />
                </div>
              )}

              {/* Existing inline fields */}
              {inlineFields.map((field) => (
                <div
                  key={field.tempId}
                  className="grid grid-cols-[1fr_140px_64px_64px_40px] gap-0 border-b border-border/50 hover:bg-accent/20 transition-colors group"
                >
                  <div className="px-space-3 py-space-2 flex items-center">
                    <span className="font-mono text-body-small text-foreground">{field.name}</span>
                  </div>
                  <div className="px-space-3 py-space-2 flex items-center">
                    <TypePicker
                      value={field.type}
                      onChange={(t) => updateInlineField(field.tempId, { type: t })}
                      compact
                    />
                  </div>
                  <div className="px-space-3 py-space-2 flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={field.nullable}
                      onChange={(e) => updateInlineField(field.tempId, { nullable: e.target.checked })}
                      className="accent-primary"
                    />
                  </div>
                  <div className="px-space-3 py-space-2 flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={field.isKey}
                      onChange={(e) => updateInlineField(field.tempId, { isKey: e.target.checked })}
                      className="accent-primary"
                    />
                  </div>
                  <div className="px-space-1 py-space-2 flex items-center justify-center">
                    <button
                      onClick={() => removeInlineField(field.tempId)}
                      className="p-1 text-muted-foreground hover:text-destructive transition-colors rounded opacity-0 group-hover:opacity-100"
                      title="Remove field"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}

              {/* Add field row */}
              <div className="grid grid-cols-[1fr_140px_auto] gap-0 p-space-2">
                <div className="px-space-1">
                  <Input
                    value={newFieldName}
                    onChange={(e) => setNewFieldName(e.target.value)}
                    placeholder="New field name..."
                    className="h-7 font-mono text-body-small"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addInlineField();
                    }}
                  />
                </div>
                <div className="px-space-1">
                  <TypePicker
                    value={newFieldType}
                    onChange={setNewFieldType}
                  />
                </div>
                <div className="px-space-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addInlineField}
                    disabled={!newFieldName.trim()}
                    className="h-7 gap-1 text-caption"
                  >
                    <Plus className="w-3 h-3" />
                    Add
                  </Button>
                </div>
              </div>
            </div>
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
      {sortedEntities.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <h2 className="text-heading-1 text-foreground mb-space-2">
            Create your first logical entity
          </h2>
          <p className="text-body text-muted-foreground mb-space-4">
            Get started by defining your first logical entity in <strong>{domainName}</strong>
          </p>
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Create Entity
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
                  onClick={() => window.location.href = `/schemas/${domainSlug}/${entity.id}`}
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
                    {new Date(entity.updatedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
