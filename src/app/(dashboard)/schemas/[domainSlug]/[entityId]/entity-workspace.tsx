"use client";

import { useState, useEffect, useTransition, useCallback, useRef, useMemo } from "react";
import { Loader2, Save, Zap, Globe } from "lucide-react";
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
import {
  generateEntityAlerts,
  generateTargetDriftAlerts,
} from "@/lib/validation/entity-alerts";
import type { CompletenessRequirements } from "@/types/schemas/domain-policy";
import { AlertsTab } from "./components/AlertsTab";
import { ApiTab } from "./components/ApiTab";
import { classifyChangeLevel } from "@/lib/validation/change-level";

type EntityStatus = "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED";
type ViewTab = "editor" | "versions" | "governance" | "alerts" | "schemas" | "api";
type RightPanelTab = "field-edit" | "typespec-preview";

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

  // Dirty state tracking for field edit panel
  const [isFieldDirty, setIsFieldDirty] = useState(false);
  const fieldDirtyRef = useRef(false);
  const handleFieldDirtyChange = useCallback((dirty: boolean) => {
    setIsFieldDirty(dirty);
    fieldDirtyRef.current = dirty;
  }, []);

  // Refs for keyboard shortcut save/discard delegation
  const fieldSaveRef = useRef<(() => void) | null>(null);
  const fieldDiscardRef = useRef<(() => void) | null>(null);

  const selectedField = selectedFieldId
    ? fields.find((f) => f.id === selectedFieldId) ?? null
    : null;

  // Navigation guard: check dirty before switching fields
  const handleFieldSelect = useCallback((fieldId: string) => {
    if (fieldDirtyRef.current) {
      const confirmed = window.confirm("You have unsaved changes. Discard and continue?");
      if (!confirmed) return;
    }
    setSelectedFieldId(fieldId);
    setRightPanelTab("field-edit");
  }, []);

  // Compute entity alerts from domain completeness requirements
  const entityAlerts = useMemo(() => {
    const completenessReqs = (domainPolicy?.completenessRequirements as CompletenessRequirements) ?? undefined;
    return [
      ...generateEntityAlerts(entity, fields, completenessReqs),
      ...generateTargetDriftAlerts(entity, fields),
    ];
  }, [entity, fields, domainPolicy]);

  const alertCount = entityAlerts.length;

  // Helper: bump semantic version in entity metadata
  const bumpSemanticVersion = useCallback(async (level: "major" | "minor") => {
    const meta = (entity.metadata ?? {}) as Record<string, unknown>;
    const sv = (meta.semanticVersion as { major?: number; minor?: number }) ?? {};
    const currentMajor = sv.major ?? entity.version;
    const currentMinor = sv.minor ?? 0;

    let newMajor = currentMajor;
    let newMinor = currentMinor;
    if (level === "major") {
      newMajor = currentMajor + 1;
      newMinor = 0;
    } else {
      newMinor = currentMinor + 1;
    }

    await updateEntityMetadataAction(entity.id, {
      semanticVersion: { major: newMajor, minor: newMinor },
    });
  }, [entity.id, entity.metadata, entity.version]);

  // Field update handler — saves field, creates version, bumps semantic version
  const handleUpdateField = useCallback(async (id: string, data: Record<string, unknown>) => {
    // Determine which properties changed by comparing to original field
    const originalField = fields.find((f) => f.id === id);
    const changedProps: string[] = [];
    if (originalField) {
      for (const key of Object.keys(data)) {
        if (key === "decorators") {
          const origTs = (originalField.decorators?.typespec ?? {}) as Record<string, unknown>;
          const newTs = ((data.decorators as Record<string, unknown>)?.typespec ?? {}) as Record<string, unknown>;
          if (JSON.stringify(origTs) !== JSON.stringify(newTs)) {
            const origIdentity = (origTs.identity ?? {}) as Record<string, unknown>;
            const newIdentity = (newTs.identity ?? {}) as Record<string, unknown>;
            if (JSON.stringify(origIdentity) !== JSON.stringify(newIdentity)) {
              if (origIdentity.format !== newIdentity.format) changedProps.push("format");
              if (origIdentity.defaultValue !== newIdentity.defaultValue) changedProps.push("defaultValue");
              if (origIdentity.secret !== newIdentity.secret) changedProps.push("secret");
            }
            if (JSON.stringify(origTs.documentation) !== JSON.stringify(newTs.documentation)) {
              changedProps.push("summary");
            }
          }
        } else {
          const origVal = (originalField as unknown as Record<string, unknown>)[key];
          if (JSON.stringify(origVal) !== JSON.stringify(data[key])) {
            changedProps.push(key);
          }
        }
      }
    }

    await updateFieldAction(id, data);
    setTypeSpecTrigger((n) => n + 1);

    // Create version snapshot and bump semantic version
    const level = classifyChangeLevel(changedProps);
    try {
      await createVersionAction(entity.id);
      await bumpSemanticVersion(level);
    } catch {
      // Version creation failure should not block the save
    }

    flashSaved();
  }, [entity.id, fields, bumpSemanticVersion, flashSaved]);

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

  // Metadata save handler — creates version + bumps minor
  const handleMetaSaved = useCallback(async () => {
    try {
      await createVersionAction(entity.id);
      await bumpSemanticVersion("minor");
    } catch {
      // Version creation failure should not block the save
    }
    flashSaved();
  }, [entity.id, bumpSemanticVersion, flashSaved]);

  // Navigation guard: tab switching
  const handleTabChange = useCallback((tab: ViewTab) => {
    if (fieldDirtyRef.current) {
      const confirmed = window.confirm("You have unsaved changes. Discard and continue?");
      if (!confirmed) return;
    }
    setActiveTab(tab);
    if (tab === "versions") {
      handleOpenHistory();
    }
  }, [handleOpenHistory]);

  // Keyboard shortcuts: Cmd+E to emit, Cmd+S to save, Escape to discard
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "e") {
        e.preventDefault();
        if (!readOnly_ && !isEmitting) {
          handleEmit();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (fieldDirtyRef.current && fieldSaveRef.current) {
          fieldSaveRef.current();
        }
      }
      if (e.key === "Escape") {
        if (fieldDirtyRef.current && fieldDiscardRef.current) {
          fieldDiscardRef.current();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleEmit, readOnly_, isEmitting]);

  // Navigation guard: beforeunload when dirty
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (fieldDirtyRef.current) {
        e.preventDefault();
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

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
        onGovernanceClick={() => handleTabChange("governance")}
        onMetaSaved={handleMetaSaved}
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
        onDirtyChange={handleFieldDirtyChange}
        fieldSaveRef={fieldSaveRef}
        fieldDiscardRef={fieldDiscardRef}
      />

      {/* View Tab Bar — definition tabs | action tabs */}
      <div className="flex items-center mb-space-4 border-b border-border/50">
        {/* Definition tabs */}
        {(["editor", "versions", "governance", "alerts"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => handleTabChange(tab)}
            className={`px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`tab-${tab}`}
          >
            {tab === "editor" ? "Editor" : tab === "versions" ? "Versions" : tab === "governance" ? "Governance" : `Alerts${alertCount > 0 ? ` (${alertCount})` : ""}`}
          </button>
        ))}

        {/* Dirty indicator */}
        {isFieldDirty && (
          <span className="w-2 h-2 rounded-full bg-warning ml-1" title="Unsaved changes" />
        )}

        {/* Separator between definition and action tabs */}
        <span className="mx-2 w-px h-4 bg-border/60 self-center" />

        {/* Action tabs — visually distinct with icons and primary accent */}
        <button
          onClick={() => handleTabChange("schemas")}
          className={`flex items-center gap-1 px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "schemas"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-primary"
          }`}
          data-testid="tab-schemas"
        >
          <Zap className="w-3 h-3" />
          Schemas
        </button>
        <button
          onClick={() => handleTabChange("api")}
          className={`flex items-center gap-1 px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "api"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-primary"
          }`}
          data-testid="tab-api"
        >
          <Globe className="w-3 h-3" />
          API
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

        {activeTab === "alerts" && (
          <div className="space-y-space-6">
            <h2 className="text-heading-2 text-foreground">Alerts</h2>
            <AlertsTab
              alerts={entityAlerts}
              onNavigateToField={(fieldId) => {
                handleFieldSelect(fieldId);
                setActiveTab("editor");
              }}
              onNavigateToTab={(tab) => {
                setActiveTab(tab as ViewTab);
              }}
            />
          </div>
        )}

        {activeTab === "api" && (
          <ApiTab
            entityId={entity.id}
            entityName={entity.name}
            fields={fields.map((f) => ({ name: f.name, type: f.type }))}
            isReadOnly={readOnly_}
          />
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
