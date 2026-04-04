"use client";

import { useState, useEffect, useTransition, useCallback, useRef } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronRight, Loader2, Zap, History, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FieldEditor } from "./field-editor";
import {
  addFieldAction,
  updateFieldAction,
  deleteFieldAction,
  updateEntityStatusAction,
  emitEntityAction,
  createTypeMappingOverrideAction,
  acknowledgeLossyMappingAction,
  createVersionAction,
  getVersionHistoryAction,
  compareVersionsAction,
  getChangeHistoryAction,
} from "./actions";
import { VersionHistoryPanel } from "@/components/custom/VersionHistoryPanel";
import { DiffViewer } from "@/components/custom/DiffViewer";
import type { VersionSnapshot, DiffResult } from "@/services/version-history/version.types";
import { EmissionPreviewPanel } from "@/components/custom/EmissionPreviewPanel";
import type { OverrideMappingInfo } from "@/components/custom/EmissionPreviewPanel";
import type { EmissionResult } from "@/lib/emission/emission.types";
import {
  TypeMappingOverrideDialog,
} from "@/components/custom/TypeMappingOverrideDialog";
import type {
  OverrideDialogMappingContext,
  CreateOverrideData,
} from "@/components/custom/TypeMappingOverrideDialog";
import { ChangeHistoryView } from "@/components/custom/ChangeHistoryView";
import type { ChangeHistoryFilters } from "@/types/schemas/change-history";
import { DeprecationBanner } from "@/components/custom/DeprecationBanner";
import { RetirementBanner } from "@/components/custom/RetirementBanner";
import { isReadOnly } from "@/lib/entity-lifecycle";
import { trackRecentEntity } from "@/lib/recent-entities";

type EntityStatus = "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED";
type ViewTab = "editor" | "history";

const STATUS_OPTIONS: { value: EntityStatus; label: string; color: string; dotColor: string }[] = [
  { value: "DRAFT", label: "DRAFT", color: "#e5a93b", dotColor: "bg-warning" },
  { value: "ACTIVE", label: "ACTIVE", color: "#5bc27a", dotColor: "bg-success" },
  { value: "DEPRECATED", label: "DEPRECATED", color: "#e88a3b", dotColor: "bg-[#e88a3b]" },
  { value: "RETIRED", label: "RETIRED", color: "#8a8694", dotColor: "bg-muted-foreground" },
];

function getStatusOption(status: string) {
  return STATUS_OPTIONS.find((o) => o.value === status) || STATUS_OPTIONS[0];
}

interface FieldData {
  id: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: Record<string, unknown>;
  sortOrder: number;
}

interface EntityWorkspaceProps {
  entity: {
    id: string;
    name: string;
    description: string;
    status: string;
    version: number;
    domainName: string;
    domainSlug: string;
    metadata: Record<string, unknown> | null;
  };
  fields: FieldData[];
  domainPolicy: Record<string, unknown> | null;
}

export function EntityWorkspace({ entity, fields, domainPolicy }: EntityWorkspaceProps) {
  const currentStatus = getStatusOption(entity.status);
  const readOnly = isReadOnly(entity.status as EntityStatus);

  // Track recent entity access for command palette
  useEffect(() => {
    trackRecentEntity({
      entityId: entity.id,
      domainSlug: entity.domainSlug,
      entityName: entity.name,
      domainName: entity.domainName,
    });
  }, [entity.id, entity.domainSlug, entity.name, entity.domainName]);

  const [isPending, startTransition] = useTransition();
  const [statusError, setStatusError] = useState<string | null>(null);

  // Emission state
  const [emissionResult, setEmissionResult] = useState<EmissionResult | null>(null);
  const [emissionPanelOpen, setEmissionPanelOpen] = useState(false);
  const [isEmitting, setIsEmitting] = useState(false);

  // Version history state
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [versionHistory, setVersionHistory] = useState<VersionSnapshot[]>([]);
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);

  // Diff viewer state
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // View tab state
  const [activeTab, setActiveTab] = useState<ViewTab>("editor");

  const handleCreateVersion = useCallback(async () => {
    setIsCreatingVersion(true);
    try {
      const response = await createVersionAction(entity.id);
      if (response.error) {
        toast.error(response.error);
        return;
      }
      toast.success(`Version v${response.version?.version} created`);
      // Refresh version history
      const historyResponse = await getVersionHistoryAction(entity.id);
      if (historyResponse.versions) {
        setVersionHistory(historyResponse.versions as VersionSnapshot[]);
      }
    } catch {
      toast.error("Failed to create version");
    } finally {
      setIsCreatingVersion(false);
    }
  }, [entity.id]);

  const handleOpenHistory = useCallback(async () => {
    const response = await getVersionHistoryAction(entity.id);
    if (response.versions) {
      setVersionHistory(response.versions as VersionSnapshot[]);
    }
    setVersionHistoryOpen(true);
  }, [entity.id]);

  const handleCompare = useCallback(async (versionA: number, versionB: number) => {
    const response = await compareVersionsAction(entity.id, versionA, versionB);
    if (response.error) {
      toast.error(response.error);
      return;
    }
    if (response.diff) {
      setDiffResult(response.diff as DiffResult);
      setShowDiff(true);
      setVersionHistoryOpen(false);
    }
  }, [entity.id]);

  const handleViewDiff = useCallback(async (version: number, previousVersion: number) => {
    await handleCompare(previousVersion, version);
  }, [handleCompare]);

  const handleCloseDiff = useCallback(() => {
    setShowDiff(false);
    setDiffResult(null);
  }, []);

  // Change history fetch handler
  const fetchChangeHistory = useCallback(
    async (
      entId: string,
      filters?: ChangeHistoryFilters,
      cursor?: string
    ) => {
      const serializedFilters = filters
        ? {
            changeTypes: filters.changeTypes,
            userId: filters.userId,
            dateFrom: filters.dateFrom?.toISOString(),
            dateTo: filters.dateTo?.toISOString(),
          }
        : undefined;
      return getChangeHistoryAction(entId, serializedFilters, cursor);
    },
    []
  );

  const handleHistoryViewDiff = useCallback(
    async (versionNumber: number, previousVersion: number) => {
      await handleCompare(previousVersion, versionNumber);
      setActiveTab("editor"); // switch to editor to show the diff
    },
    [handleCompare]
  );

  // Override dialog state
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideMappingContext, setOverrideMappingContext] = useState<OverrideDialogMappingContext | null>(null);
  const [overrides, setOverrides] = useState<OverrideMappingInfo[]>([]);

  const handleEmit = useCallback(async () => {
    setIsEmitting(true);
    try {
      const response = await emitEntityAction(entity.id);
      if (response.error) {
        toast.error(response.error);
        return;
      }
      if (response.result) {
        setEmissionResult(response.result);
        setEmissionPanelOpen(true);
        const { summary } = response.result;
        if (summary.invalidCount === 0 && summary.warningCount === 0) {
          toast.success(`Emitted to ${summary.totalTargets} targets — all valid`);
        } else if (summary.invalidCount === 0) {
          toast.warning(
            `Emitted to ${summary.totalTargets} targets — ${summary.warningCount} warning${summary.warningCount !== 1 ? "s" : ""}`
          );
        } else {
          toast.error(
            `Emission failed: ${summary.invalidCount} target${summary.invalidCount !== 1 ? "s" : ""} invalid`
          );
        }
      }
    } catch {
      toast.error("Emission failed unexpectedly");
    } finally {
      setIsEmitting(false);
    }
  }, [entity.id]);

  // Override dialog handlers
  const handleWarningClick = useCallback((info: OverrideMappingInfo) => {
    setOverrideMappingContext({
      sourceType: info.sourceType,
      targetFormat: info.targetFormat,
      currentMappedType: info.currentMappedType,
      lossDescription: info.lossDescription,
      fieldName: info.fieldName,
    });
    setOverrideDialogOpen(true);
  }, []);

  const handleCreateOverride = useCallback(async (data: CreateOverrideData) => {
    const result = await createTypeMappingOverrideAction({
      ...data,
      entityId: entity.id,
    });
    if (result.error) {
      throw new Error(result.error);
    }
    // Add to local overrides for badge display
    setOverrides((prev) => [
      ...prev,
      {
        sourceType: data.sourceType,
        targetFormat: data.targetFormat,
        currentMappedType: data.mappedType,
        isOverride: true,
        overrideSource: data.scope === "global" ? "global" : "per-entity",
      },
    ]);
    // Re-emit to reflect the override
    await handleEmit();
  }, [entity.id, handleEmit]);

  const handleAcknowledge = useCallback(async (sourceType: string, targetFormat: string) => {
    const result = await acknowledgeLossyMappingAction({
      entityId: entity.id,
      sourceType,
      targetFormat,
    });
    if (result.error) {
      throw new Error(result.error);
    }
  }, [entity.id]);

  // Keyboard shortcut: Cmd+E / Ctrl+E to emit
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "e") {
        e.preventDefault();
        if (!readOnly && !isEmitting) {
          handleEmit();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleEmit, readOnly, isEmitting]);

  // Deprecation form state
  const [showDeprecationForm, setShowDeprecationForm] = useState(false);
  const [depSince, setDepSince] = useState(new Date().toISOString().split("T")[0]);
  const [depReplacementEntityId, setDepReplacementEntityId] = useState("");
  const [depMigrationNotes, setDepMigrationNotes] = useState("");
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // Close status dropdown on click outside or Escape
  useEffect(() => {
    if (!statusDropdownOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setStatusDropdownOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setStatusDropdownOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [statusDropdownOpen]);

  function handleStatusChange(newStatus: EntityStatus) {
    setStatusError(null);
    setStatusDropdownOpen(false);

    if (newStatus === entity.status) return;

    if (newStatus === "DEPRECATED") {
      // Show deprecation form first
      setShowDeprecationForm(true);
      return;
    }

    startTransition(async () => {
      const result = await updateEntityStatusAction(entity.id, newStatus);
      if (result?.error) {
        setStatusError(result.error);
      }
    });
  }

  function handleDeprecationSubmit() {
    startTransition(async () => {
      const existingMeta = (entity.metadata || {}) as Record<string, unknown>;
      const metadata = {
        ...existingMeta,
        deprecation: {
          deprecated: true,
          since: depSince,
          replacementEntityId: depReplacementEntityId || null,
          migrationNotes: depMigrationNotes || undefined,
        },
      };
      const result = await updateEntityStatusAction(entity.id, "DEPRECATED", metadata);
      if (result?.error) {
        setStatusError(result.error);
      } else {
        setShowDeprecationForm(false);
      }
    });
  }

  return (
    <div className="animate-auth-fade-up">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        <Link href="/schemas" className="hover:text-foreground transition-colors">
          Domains
        </Link>
        <ChevronRight className="w-3 h-3" />
        <Link
          href={`/schemas/${entity.domainSlug}`}
          className="hover:text-foreground transition-colors"
        >
          {entity.domainName}
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium font-mono">{entity.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-center justify-between mb-space-4">
        <div className="flex items-center gap-space-3">
          <h1 className="text-display text-foreground font-mono">{entity.name}</h1>
          <span className={`w-2.5 h-2.5 rounded-full ${currentStatus.dotColor}`} />

          {/* Status dropdown */}
          <div className="relative" ref={statusDropdownRef}>
            <button
              onClick={() => !readOnly && setStatusDropdownOpen(!statusDropdownOpen)}
              disabled={readOnly}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-body-small transition-colors hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ color: currentStatus.color }}
            >
              {entity.status}
              {!readOnly && (
                <ChevronRight className="w-3 h-3 rotate-90" />
              )}
            </button>

            {statusDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 min-w-[140px] rounded-lg border border-border bg-popover shadow-md py-1">
                {STATUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleStatusChange(opt.value)}
                    disabled={opt.value === entity.status}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-body-small text-left hover:bg-accent/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: opt.color }}
                    />
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <Badge variant="secondary">v{entity.version}</Badge>
        </div>

        <div className="flex items-center gap-space-2">
          {/* History button */}
          <Button
            variant="outline"
            onClick={handleOpenHistory}
            className="gap-1.5"
            title="View version history"
          >
            <History className="w-4 h-4" />
            History
          </Button>

          {/* Create Version button */}
          {!readOnly && (
            <Button
              variant="outline"
              onClick={handleCreateVersion}
              disabled={isCreatingVersion}
              className="gap-1.5"
              title="Save current state as a new version"
            >
              {isCreatingVersion ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Create Version
                </>
              )}
            </Button>
          )}

          {/* Emit button */}
          {!readOnly && (
            <Button
              onClick={handleEmit}
              disabled={isEmitting || fields.length === 0}
              className="gap-1.5"
              title={
                fields.length === 0
                  ? "Add fields before emitting"
                  : "Emit to all targets (Ctrl+E)"
              }
            >
              {isEmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Emitting...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4" />
                  Emit
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Status transition error */}
      {statusError && (
        <div className="mb-space-4 rounded-lg border border-destructive/50 bg-destructive/10 px-space-4 py-space-2 text-body-small text-destructive">
          {statusError}
        </div>
      )}

      {/* Deprecation inline form */}
      {showDeprecationForm && (
        <div className="mb-space-4 rounded-xl border px-space-4 py-space-4 space-y-space-3" style={{ borderColor: "#e88a3b", backgroundColor: "rgba(232,138,59,0.08)" }}>
          <h4 className="text-body-small font-medium text-foreground">Deprecation Details</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-3">
            <div>
              <label className="text-caption text-muted-foreground mb-1 block">Deprecated Since</label>
              <Input
                type="date"
                value={depSince}
                onChange={(e) => setDepSince(e.target.value)}
                className="h-8 text-body-small"
              />
            </div>
            <div>
              <label className="text-caption text-muted-foreground mb-1 block">Replacement Entity ID</label>
              <Input
                value={depReplacementEntityId}
                onChange={(e) => setDepReplacementEntityId(e.target.value)}
                placeholder="Entity ID (optional)"
                className="h-8 text-body-small"
              />
            </div>
          </div>
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Migration Notes</label>
            <textarea
              value={depMigrationNotes}
              onChange={(e) => setDepMigrationNotes(e.target.value)}
              placeholder="Optional migration guidance..."
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-body-small text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring resize-none"
              rows={3}
            />
          </div>
          <div className="flex items-center gap-space-2">
            <Button
              size="sm"
              onClick={handleDeprecationSubmit}
              disabled={isPending}
            >
              {isPending ? "Saving..." : "Mark as Deprecated"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowDeprecationForm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Banners */}
      {entity.status === "DEPRECATED" && (
        <DeprecationBanner metadata={entity.metadata} domainSlug={entity.domainSlug} />
      )}
      {entity.status === "RETIRED" && (
        <RetirementBanner metadata={entity.metadata} />
      )}

      {entity.description && (
        <p className="text-body text-muted-foreground mb-space-6">{entity.description}</p>
      )}

      {/* View Tab Bar */}
      <div className="flex items-center gap-space-1 mb-space-4 border-b border-border/50">
        <button
          onClick={() => { setActiveTab("editor"); }}
          className={`px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "editor"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-editor"
        >
          Editor
        </button>
        <button
          onClick={() => { setActiveTab("history"); setShowDiff(false); setDiffResult(null); }}
          className={`px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "history"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-history"
        >
          Change History
        </button>
      </div>

      {/* Center Panel */}
      <div className="mb-space-8">
        {activeTab === "editor" ? (
          showDiff && diffResult ? (
            <DiffViewer diff={diffResult} onClose={handleCloseDiff} />
          ) : (
            <>
              <h2 className="text-heading-2 text-foreground mb-space-4">
                Fields ({fields.length})
              </h2>
              <FieldEditor
                entityId={entity.id}
                domainSlug={entity.domainSlug}
                fields={fields}
                domainPolicy={domainPolicy}
                isReadOnly={readOnly}
                onAddField={async (name, type, opts) => {
                  await addFieldAction(entity.id, name, type, opts);
                }}
                onUpdateField={async (id, data) => {
                  await updateFieldAction(id, data);
                }}
                onDeleteField={async (id) => {
                  await deleteFieldAction(id);
                }}
              />
            </>
          )
        ) : (
          <ChangeHistoryView
            entityId={entity.id}
            fetchHistory={fetchChangeHistory}
            onViewDiff={handleHistoryViewDiff}
          />
        )}
      </div>

      {/* Emission Preview Panel */}
      {emissionResult && (
        <EmissionPreviewPanel
          result={emissionResult}
          open={emissionPanelOpen}
          onClose={() => setEmissionPanelOpen(false)}
          entityId={entity.id}
          userRole="STEWARD"
          onWarningClick={handleWarningClick}
          overrides={overrides}
        />
      )}

      {/* Type Mapping Override Dialog */}
      <TypeMappingOverrideDialog
        open={overrideDialogOpen}
        onClose={() => setOverrideDialogOpen(false)}
        mappingContext={overrideMappingContext}
        entityId={entity.id}
        userRole="STEWARD"
        onCreateOverride={handleCreateOverride}
        onAcknowledge={handleAcknowledge}
      />

      {/* Version History Panel */}
      <VersionHistoryPanel
        versions={versionHistory}
        open={versionHistoryOpen}
        onClose={() => setVersionHistoryOpen(false)}
        onCompare={handleCompare}
        onViewDiff={handleViewDiff}
      />
    </div>
  );
}
