"use client";

import { useState, useEffect, useTransition, useCallback, useRef } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
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
import { SchemasTab } from "./components/SchemasTab";
import { DiffViewer } from "@/components/custom/DiffViewer";
import type { VersionSnapshot, DiffResult } from "@/services/version-history/version.types";
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
import { isReadOnly } from "@/lib/entity-lifecycle";
import { trackRecentEntity } from "@/lib/recent-entities";
import { EntityHeader } from "./components/EntityHeader";
import { EntityToolbar } from "./components/EntityToolbar";
import { RightPanelRouter } from "./components/RightPanelRouter";
import { InlineEntityMeta } from "./components/InlineEntityMeta";
import { RetentionPolicyEditor } from "@/features/governance/RetentionPolicyEditor/RetentionPolicyEditor";
import { updateEntityMetadataAction } from "./actions";
import type { RetentionPolicy } from "@/types/schemas/retention-policy.schema";
import {
  migrateSimpleRetention,
} from "@/types/schemas/retention-policy.schema";

type EntityStatus = "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED";
type ViewTab = "editor" | "schemas" | "versions" | "governance";
type RightPanelTab = "quick-edit" | "typespec-preview";

interface FieldData {
  id: string;
  slug?: string;
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
    slug: string;
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
  const readOnly_ = isReadOnly(entity.status as EntityStatus);

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

  // "Saved" flash indicator state
  const [showSaved, setShowSaved] = useState(false);
  const savedTimerRef = useRef<NodeJS.Timeout | null>(null);
  const flashSaved = useCallback(() => {
    setShowSaved(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setShowSaved(false), 2000);
  }, []);

  // Emission state
  const [emissionResult, setEmissionResult] = useState<EmissionResult | null>(null);
  const [isEmitting, setIsEmitting] = useState(false);

  // Version history state
  const [versionHistory, setVersionHistory] = useState<VersionSnapshot[]>([]);
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);

  // Diff viewer state
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // View tab state
  const [activeTab, setActiveTab] = useState<ViewTab>("editor");

  // Right panel state
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("typespec-preview");
  const [typeSpecTrigger, setTypeSpecTrigger] = useState(0);

  const selectedField = selectedFieldId
    ? fields.find((f) => f.id === selectedFieldId) ?? null
    : null;

  const handleFieldSelect = useCallback((fieldId: string) => {
    setSelectedFieldId(fieldId);
    setRightPanelTab("quick-edit");
  }, []);

  const handleUpdateField = useCallback(async (id: string, data: Record<string, unknown>) => {
    await updateFieldAction(id, data);
    setTypeSpecTrigger((n) => n + 1);
  }, []);

  // Override dialog state
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideMappingContext, setOverrideMappingContext] = useState<OverrideDialogMappingContext | null>(null);
  const [overrides, setOverrides] = useState<OverrideMappingInfo[]>([]);

  // --- Handlers ---

  const handleStatusChange = useCallback((newStatus: EntityStatus, metadata?: Record<string, unknown>) => {
    setStatusError(null);
    if (newStatus === entity.status) return;

    startTransition(async () => {
      const result = await updateEntityStatusAction(entity.id, newStatus, metadata);
      if (result?.error) {
        setStatusError(result.error);
      } else {
        flashSaved();
      }
    });
  }, [entity.id, entity.status, flashSaved]);

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

  const handleCreateVersion = useCallback(async () => {
    setIsCreatingVersion(true);
    try {
      const response = await createVersionAction(entity.id);
      if (response.error) {
        toast.error(response.error);
        return;
      }
      toast.success(`Version v${response.version?.version} created`);
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
    }
  }, [entity.id]);

  const handleViewDiff = useCallback(async (version: number, previousVersion: number) => {
    await handleCompare(previousVersion, version);
  }, [handleCompare]);

  const handleCloseDiff = useCallback(() => {
    setShowDiff(false);
    setDiffResult(null);
  }, []);

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
      setActiveTab("editor");
    },
    [handleCompare]
  );

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
        if (!readOnly_ && !isEmitting) {
          handleEmit();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleEmit, readOnly_, isEmitting]);

  return (
    <div className="animate-auth-fade-up">
      <EntityHeader
        entity={entity}
        onStatusChange={handleStatusChange}
        readOnly={readOnly_}
        isPending={isPending}
        statusError={statusError}
        showSaved={showSaved}
        toolbar={
          <EntityToolbar />
        }
      />

      {/* Inline entity metadata */}
      <InlineEntityMeta
        entity={entity}
        isReadOnly={readOnly_}
        onGovernanceClick={() => setActiveTab("governance")}
      />

      {/* Right panel router (renders nothing itself, pushes content via context) */}
      <RightPanelRouter
        selectedField={selectedField}
        entityId={entity.id}
        entitySlug={entity.slug}
        domainSlug={entity.domainSlug}
        isReadOnly={readOnly_}
        rightPanelTab={rightPanelTab}
        onTabChange={setRightPanelTab}
        onUpdateField={handleUpdateField}
        typeSpecTrigger={typeSpecTrigger}
        existingFields={fields.map((f) => ({
          name: f.name,
          type: f.type,
          isOptional: f.nullable,
          isKey: f.isKey,
        }))}
        onTypeSpecApplied={() => {
          // Trigger page refresh to reload fields from DB
          window.location.reload();
        }}
      />

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
          onClick={() => { setActiveTab("schemas"); }}
          className={`px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "schemas"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-schemas"
        >
          Schemas
        </button>
        <button
          onClick={() => { setActiveTab("versions"); handleOpenHistory(); }}
          className={`px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "versions"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-versions"
        >
          Versions
        </button>
        <button
          onClick={() => { setActiveTab("governance"); }}
          className={`px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "governance"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-governance"
        >
          Governance
        </button>
      </div>

      {/* Center Panel */}
      <div key={activeTab} className="mb-space-8 animate-in fade-in duration-150">
        {activeTab === "editor" && (
          showDiff && diffResult ? (
            <DiffViewer diff={diffResult} onClose={handleCloseDiff} />
          ) : (
            <>
              <h2 className="text-heading-2 text-foreground mb-space-4">
                Fields ({fields.length})
              </h2>
              <FieldEditor
                entityId={entity.id}
                entitySlug={entity.slug}
                domainSlug={entity.domainSlug}
                fields={fields}
                domainPolicy={domainPolicy}
                isReadOnly={readOnly_}
                selectedFieldId={selectedFieldId}
                onFieldSelect={handleFieldSelect}
                onAddField={async (name, type, opts) => {
                  const result = await addFieldAction(entity.id, name, type, opts);
                  setTypeSpecTrigger((n) => n + 1);
                  return result;
                }}
                onUpdateField={async (id, data) => {
                  await updateFieldAction(id, data);
                  setTypeSpecTrigger((n) => n + 1);
                }}
                onDeleteField={async (id) => {
                  await deleteFieldAction(id);
                  if (selectedFieldId === id) {
                    setSelectedFieldId(null);
                    setRightPanelTab("typespec-preview");
                  }
                  setTypeSpecTrigger((n) => n + 1);
                }}
              />
            </>
          )
        )}

        {activeTab === "schemas" && (
          <SchemasTab
            entityId={entity.id}
            entityName={entity.name}
            fields={fields}
            entity={{
              id: entity.id,
              name: entity.name,
              slug: entity.slug,
              domainSlug: entity.domainSlug,
              version: entity.version,
              metadata: entity.metadata,
            }}
          />
        )}

        {activeTab === "versions" && (
          <div className="space-y-space-6">
            <div className="flex items-center justify-between">
              <h2 className="text-heading-2 text-foreground">Version History</h2>
              {!readOnly_ && (
                <Button
                  variant="outline"
                  onClick={handleCreateVersion}
                  disabled={isCreatingVersion}
                  className="gap-1.5"
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
            </div>

            {/* Diff viewer */}
            {showDiff && diffResult && (
              <DiffViewer diff={diffResult} onClose={handleCloseDiff} />
            )}

            {/* Version list */}
            {versionHistory.length > 0 ? (
              <div className="space-y-space-2">
                {versionHistory.map((v, idx) => (
                  <div
                    key={v.version}
                    className="flex items-center justify-between rounded-lg border border-border/50 px-space-4 py-space-3"
                  >
                    <div>
                      <span className="text-body-small font-medium text-foreground">
                        v{v.version}
                      </span>
                      <span className="text-caption text-muted-foreground ml-space-3">
                        {new Date(v.timestamp).toLocaleString()}
                      </span>
                    </div>
                    {idx < versionHistory.length - 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          handleViewDiff(v.version, versionHistory[idx + 1].version)
                        }
                        className="text-caption"
                      >
                        View Diff
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-body-small text-muted-foreground">
                No versions created yet.
              </p>
            )}

            {/* Change log */}
            <div className="border-t border-border/50 pt-space-4">
              <h3 className="text-heading-3 text-foreground mb-space-3">Change Log</h3>
              <ChangeHistoryView
                entityId={entity.id}
                fetchHistory={fetchChangeHistory}
                onViewDiff={handleHistoryViewDiff}
              />
            </div>
          </div>
        )}

        {activeTab === "governance" && (
          <div className="space-y-space-6">
            <h2 className="text-heading-2 text-foreground">Governance</h2>
            <RetentionPolicyEditor
              entityId={entity.id}
              entityName={entity.name}
              fields={fields.map((f) => ({ name: f.name, type: f.type }))}
              currentPolicy={(() => {
                const meta = (entity.metadata ?? {}) as Record<string, unknown>;
                const raw = meta.retentionPolicy;
                if (raw && typeof raw === "object") return raw as RetentionPolicy;
                if (typeof raw === "string" && raw) return migrateSimpleRetention(raw);
                return null;
              })()}
              onSave={async (_entityId, policy) => {
                await updateEntityMetadataAction(entity.id, {
                  retentionPolicy: policy as unknown as Record<string, unknown>,
                });
                toast.success("Retention policy saved");
              }}
            />
          </div>
        )}
      </div>

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
    </div>
  );
}
