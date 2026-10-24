"use client";

import { useState, useEffect, useTransition, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Zap, Globe, Rocket, FileCode, Upload } from "lucide-react";
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
  getVersionHistoryAction,
  compareVersionsAction,
  getChangeHistoryAction,
} from "./actions";
import { deleteEntityAction } from "../../actions";
import { SchemasTab } from "./components/SchemasTab";
import { EntityDeploymentsTab } from "./components/EntityDeploymentsTab";
import { TypeSpecSourceTab } from "./components/TypeSpecSourceTab";
import { DiffViewer } from "@/components/custom/DiffViewer";
import type { VersionSnapshot, DiffResult } from "@/services/version-history/version.types";
import {
  TypeMappingOverrideDialog,
} from "@/components/custom/TypeMappingOverrideDialog";
import type {
  CreateOverrideData,
} from "@/components/custom/TypeMappingOverrideDialog";
import { ChangeHistoryView } from "@/components/custom/ChangeHistoryView";
import type { ChangeHistoryFilters } from "@/types/schemas/change-history";
import { formatDateTime } from "@/lib/date-format";
import { isReadOnly } from "@/lib/entity-lifecycle";
import { trackRecentEntity } from "@/lib/recent-entities";
import { EntityHeader } from "./components/EntityHeader";
import type { ReplacementEntityLink } from "@/components/custom/DeprecationBanner";
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
  generateReferenceStalenessAlerts,
  generateTargetDriftAlerts,
} from "@/lib/validation/entity-alerts";
import type { ReferenceStaleness } from "@/lib/entity-versioning/referenced-versions";
import type { CompletenessRequirements } from "@/types/schemas/domain-policy";
import { AlertsTab } from "./components/AlertsTab";
import { ApiTab, type ApiOperationData } from "./components/ApiTab";
import { assetHref } from "@/lib/navigation/asset-href";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { getPublishPreviewAction, publishEntityAction, listEntityVersionsAction } from "./version-actions";
import { PublishEntityDialog } from "./components/PublishEntityDialog";
import { EntityVersionList } from "./components/EntityVersionList";
import { UsedByPanel } from "@/features/events/shared/UsedByPanel";
import { needsReferenceOf, type PublishAnalysis } from "@/lib/entity-versioning/publish-plan";
import { useReferencePick } from "./components/useReferencePick";
import type { EntityVersionSummary, PublishInput } from "@/lib/entity-versioning/types";
import type { DraftVersionState } from "@/lib/entity-versioning/draft-label";
type EntityStatus = "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED";
type ViewTab = "editor" | "versions" | "governance" | "alerts" | "schemas" | "api" | "deployments" | "typespec";
type RightPanelTab = "field-edit" | "typespec-preview";

/** Message for a thrown value (server actions reject on network or server failures). */
function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Unexpected error";
}

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

export interface EntityWorkspaceProps {
  /**
   * Where the entity lives. TENANT (Enterprise) entities have no domain or
   * product, so features that need one (the APIs tab) are hidden.
   */
  level: "TENANT" | "PRODUCT";
  entity: {
    id: string;
    name: string;
    slug: string;
    description: string;
    status: string;
    version: number;
    /** null for tenant-level entities (no domain placement). */
    domainId: string | null;
    domainName: string;
    /** null for tenant-level entities (no domain placement). */
    domainSlug: string | null;
    /** null for tenant-level entities (no product placement). */
    productSlug: string | null;
    /** null for tenant-level entities (no product placement). */
    productName: string | null;
    metadata: Record<string, unknown> | null;
    /** Draft + Publish state (spec §5.3). Optional so loaders that predate Phase 2a still compile. */
    hasUnpublishedChanges?: boolean;
    latestVersionLabel?: string | null;
  };
  fields: FieldData[];
  domainPolicy: Record<string, unknown> | null;
  apiServiceId: string | null;
  apiOperations: ApiOperationData[];
  /**
   * The entity named by `metadata.deprecation.replacementEntityId`, resolved by the
   * loader. null when none is named or it cannot be found in the tenant.
   */
  replacementEntity?: ReplacementEntityLink | null;
  /**
   * The unpinned references of the latest published version whose entity has published a newer version since (Task 8), computed by the
   * loader from what the publish recorded. Optional so loaders and tests that predate it still compile; absent reads as none.
   */
  referenceStaleness?: ReferenceStaleness[];
}

export function EntityWorkspace({ level, entity, fields, domainPolicy, apiServiceId, apiOperations, replacementEntity, referenceStaleness }: EntityWorkspaceProps) {
  const readOnly_ = isReadOnly(entity.status as EntityStatus);

  // Track recent entity access for command palette
  useEffect(() => {
    trackRecentEntity({
      entityId: entity.id,
      domainSlug: entity.domainSlug,
      entityName: entity.name,
      domainName: entity.domainName,
      slug: entity.slug,
      productSlug: entity.productSlug,
    });
  }, [entity.id, entity.domainSlug, entity.name, entity.domainName, entity.slug, entity.productSlug]);

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
  const [isEmitting, setIsEmitting] = useState(false);

  // Entity delete state
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeletingEntity, setIsDeletingEntity] = useState(false);

  // Version history state
  const [versionHistory, setVersionHistory] = useState<VersionSnapshot[]>([]);

  // Diff viewer state
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // View tab state
  const [activeTab, setActiveTab] = useState<ViewTab>("editor");

  // Draft + Publish state (spec §5.3). Server props are the source of truth;
  // saves flip the local copy until the next server render (React "adjust
  // state when props change" pattern — no effect).
  const serverVersionKey = `${entity.latestVersionLabel ?? ""}|${entity.hasUnpublishedChanges ?? true}`;
  const [versionStateKey, setVersionStateKey] = useState(serverVersionKey);
  const [versionState, setVersionState] = useState<DraftVersionState>({
    latestVersionLabel: entity.latestVersionLabel ?? null,
    hasUnpublishedChanges: entity.hasUnpublishedChanges ?? true,
  });
  if (versionStateKey !== serverVersionKey) {
    setVersionStateKey(serverVersionKey);
    setVersionState({
      latestVersionLabel: entity.latestVersionLabel ?? null,
      hasUnpublishedChanges: entity.hasUnpublishedChanges ?? true,
    });
  }
  const markDraftDirty = useCallback(() => {
    setVersionState((s) => (s.hasUnpublishedChanges ? s : { ...s, hasUnpublishedChanges: true }));
  }, []);

  // Publish dialog + published versions
  const [publishedVersions, setPublishedVersions] = useState<EntityVersionSummary[]>([]);
  // The versions tab must not say "Not published yet" before the first load finishes, or when it failed.
  const [versionsLoaded, setVersionsLoaded] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishPreview, setPublishPreview] = useState<PublishAnalysis | null>(null);
  const [publishLoadError, setPublishLoadError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // "Which entity do you mean?" for an ambiguous bare-name reference that blocks the publish (opens over the publish dialog).
  const { pickReference, resolveReferences, dialog: referenceDialog } = useReferencePick();

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
      ...generateReferenceStalenessAlerts(referenceStaleness ?? []),
      ...generateTargetDriftAlerts(entity, fields),
    ];
  }, [entity, fields, domainPolicy, referenceStaleness]);

  const alertCount = entityAlerts.length;

  // Field save — Story 2-22's explicit Save stays; saving updates the draft
  // only (spec D1). Versions are cut by Publish, never by Save.
  const handleUpdateField = useCallback(async (id: string, data: Record<string, unknown>) => {
    const result = await updateFieldAction(id, data);
    setTypeSpecTrigger((n) => n + 1);
    if (result?.error) {
      toast.error(result.error);
      return;
    }
    markDraftDirty();
    flashSaved();
  }, [flashSaved, markDraftDirty]);

  // Override dialog state
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);

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

  const handleOpenHistory = useCallback(async () => {
    // allSettled: a failure in one list must not hide the other, and nothing may go unreported.
    const [published, legacy] = await Promise.allSettled([
      listEntityVersionsAction(entity.id),
      getVersionHistoryAction(entity.id),
    ]);
    if (published.status === "rejected") {
      setVersionsError(errorMessage(published.reason));
    } else if ("error" in published.value) {
      setVersionsError(published.value.error);
    } else {
      setVersionsError(null);
      setPublishedVersions(published.value.versions);
    }
    if (legacy.status === "fulfilled" && legacy.value.versions) {
      setVersionHistory(legacy.value.versions as VersionSnapshot[]);
    }
    setVersionsLoaded(true);
  }, [entity.id]);

  // Loads the publish preview. An ambiguous reference that blocks it is asked right away (the pick dialog opens over the publish dialog,
  // the pick is saved on the entity + field that hold the reference, often a member of the closure) and the preview is loaded again.
  // Cancelling leaves the blocker listed, with a button to choose.
  const loadPublishPreview = useCallback(async () => {
    setPublishLoadError(null);
    const asked = new Set<string>();
    try {
      for (;;) {
        const res = await getPublishPreviewAction(entity.id);
        if ("error" in res) {
          setPublishLoadError(res.error);
          return;
        }
        setPublishPreview(res.preview);
        const needs = needsReferenceOf(res.preview.blockers);
        if (!needs) return;
        // A pick that was saved and still blocks is not asked again (the blocker stays listed).
        const key = `${needs.entityId}:${needs.fieldId}`;
        if (asked.has(key)) return;
        asked.add(key);
        if (!(await pickReference(needs))) return;
      }
    } catch (e) {
      // Without this the dialog would spin on "Checking changes…" forever.
      setPublishLoadError(`Could not load the publish preview: ${errorMessage(e)}`);
    }
  }, [entity.id, pickReference]);

  const handleOpenPublish = useCallback(async () => {
    if (fieldDirtyRef.current) {
      const confirmed = window.confirm("You have unsaved field edits. Publish the last saved draft without them?");
      if (!confirmed) return;
    }
    setPublishOpen(true);
    setPublishPreview(null);
    setPublishError(null);
    await loadPublishPreview();
  }, [loadPublishPreview]);

  const handleConfirmPublish = useCallback(async (input: PublishInput) => {
    setIsPublishing(true);
    setPublishError(null);
    try {
      // A publish refused for an ambiguous reference answers the pick beside its error: ask it first, save it, publish once more.
      const res = await resolveReferences(() => publishEntityAction(entity.id, input));
      if (!res) return; // the user declined to choose: nothing was published, the dialog stays as it was
      if ("error" in res) {
        setPublishError(res.error);
        return;
      }
      setVersionState({ latestVersionLabel: res.version.label, hasUnpublishedChanges: false });
      setPublishedVersions((prev) => [res.version, ...prev]);
      setPublishOpen(false);
      toast.success(`Published ${entity.name} v${res.version.label}`);
      router.refresh();
    } catch (e) {
      setPublishError(`Publishing failed: ${errorMessage(e)}`);
    } finally {
      setIsPublishing(false);
    }
  }, [entity.id, entity.name, router, resolveReferences]);

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


  const handleCreateOverride = useCallback(async (data: CreateOverrideData) => {
    const result = await createTypeMappingOverrideAction({
      ...data,
      entityId: entity.id,
    });
    if (result.error) {
      throw new Error(result.error);
    }
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

  const handleDeleteEntity = useCallback(async () => {
    setIsDeletingEntity(true);
    try {
      const result = await deleteEntityAction(entity.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`"${entity.name}" deleted`);
        void invalidateDomainsTree(); // the explorer reads a cached tree: without this the deleted entity row stays until a reload
        router.push(
          entity.domainSlug && entity.productSlug
            ? assetHref({ kind: "product", domainSlug: entity.domainSlug, productSlug: entity.productSlug })
            : assetHref({ kind: "enterprise" })
        );
      }
    } catch {
      toast.error("Failed to delete entity");
    } finally {
      setIsDeletingEntity(false);
      setDeleteConfirmOpen(false);
    }
  }, [entity.id, entity.name, entity.domainSlug, entity.productSlug, router, invalidateDomainsTree]);

  // Metadata save (tags / owner) — updates the draft only (spec D1).
  const handleMetaSaved = useCallback(() => {
    markDraftDirty();
    flashSaved();
  }, [flashSaved, markDraftDirty]);

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
        if (deleteConfirmOpen) {
          setDeleteConfirmOpen(false);
          return;
        }
        if (fieldDirtyRef.current && fieldDiscardRef.current) {
          fieldDiscardRef.current();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleEmit, readOnly_, isEmitting, deleteConfirmOpen]);

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
    <>
    {deleteConfirmOpen && (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-labelledby="entity-delete-confirm-title">
        <div className="bg-background border border-border rounded-xl shadow-xl p-space-6 max-w-sm w-full mx-4">
          <h3 id="entity-delete-confirm-title" className="text-heading-3 text-foreground mb-2">
            Delete &ldquo;{entity.name}&rdquo;?
          </h3>
          <p className="text-body-small text-muted-foreground mb-4">
            Permanently deletes this entity and all its fields. This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={isDeletingEntity}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteEntity}
              disabled={isDeletingEntity}
            >
              {isDeletingEntity ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      </div>
    )}
    <div className="animate-auth-fade-up">
      <EntityHeader
        level={level}
        entity={entity}
        onStatusChange={handleStatusChange}
        readOnly={readOnly_}
        isPending={isPending}
        statusError={statusError}
        showSaved={showSaved}
        versionState={versionState}
        onPublish={readOnly_ ? undefined : handleOpenPublish}
        replacementEntity={replacementEntity}
        toolbar={
          <EntityToolbar
            onDelete={readOnly_ ? undefined : () => setDeleteConfirmOpen(true)}
          />
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
        {level === "PRODUCT" && (
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
        )}
        <button
          onClick={() => handleTabChange("deployments")}
          className={`flex items-center gap-1 px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "deployments"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-primary"
          }`}
          data-testid="tab-deployments"
        >
          <Rocket className="w-3 h-3" />
          Deployments
        </button>
        <button
          onClick={() => handleTabChange("typespec")}
          className={`flex items-center gap-1 px-space-3 py-space-2 text-body-small font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "typespec"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-primary"
          }`}
          data-testid="tab-typespec"
        >
          <FileCode className="w-3 h-3" />
          TypeSpec
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
                productSlug={entity.productSlug}
                fields={fields}
                domainPolicy={domainPolicy}
                isReadOnly={readOnly_}
                selectedFieldId={selectedFieldId}
                onFieldSelect={handleFieldSelect}
                onAddField={async (name, type, opts) => {
                  const result = await addFieldAction(entity.id, name, type, opts);
                  setTypeSpecTrigger((n) => n + 1);
                  if (result?.error) toast.error(result.error);
                  else markDraftDirty();
                  return result;
                }}
                onUpdateField={async (id, data) => {
                  const result = await updateFieldAction(id, data);
                  setTypeSpecTrigger((n) => n + 1);
                  if (result?.error) toast.error(result.error);
                  else markDraftDirty();
                }}
                onDeleteField={async (id) => {
                  const result = await deleteFieldAction(id);
                  if (selectedFieldId === id) {
                    setSelectedFieldId(null);
                    setRightPanelTab("typespec-preview");
                  }
                  setTypeSpecTrigger((n) => n + 1);
                  if (result?.error) toast.error(result.error);
                  else markDraftDirty();
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

        {activeTab === "deployments" && (
          <EntityDeploymentsTab entityId={entity.id} entityName={entity.name} />
        )}

        {activeTab === "typespec" && (
          <TypeSpecSourceTab entityId={entity.id} entityName={entity.name} readOnly={readOnly_} onSaved={markDraftDirty} />
        )}

        {activeTab === "versions" && (
          <div className="space-y-space-6">
            <div className="flex items-center justify-between">
              <h2 className="text-heading-2 text-foreground">Published Versions</h2>
              {!readOnly_ && (
                <Button
                  variant="outline"
                  onClick={handleOpenPublish}
                  className="gap-1.5"
                  data-testid="versions-publish-button"
                >
                  <Upload className="w-4 h-4" />
                  Publish
                </Button>
              )}
            </div>
            {versionsError ? (
              <p role="alert" data-testid="versions-error" className="text-body-small text-destructive">
                Could not load published versions: {versionsError}
              </p>
            ) : !versionsLoaded ? (
              <p data-testid="versions-loading" className="text-body-small text-muted-foreground">
                Loading published versions…
              </p>
            ) : (
              <EntityVersionList versions={publishedVersions} />
            )}

            <UsedByPanel subject={{ kind: "entity", entityId: entity.id }} />

            <div className="border-t border-border/50 pt-space-4 space-y-space-3">
              <h3 className="text-heading-3 text-foreground">Legacy history (read-only)</h3>
              {showDiff && diffResult && (
                <DiffViewer diff={diffResult} onClose={handleCloseDiff} />
              )}
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
                          {formatDateTime(v.timestamp)}
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
                <p className="text-body-small text-muted-foreground">No legacy snapshots.</p>
              )}
            </div>

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
                const res = await updateEntityMetadataAction(entity.id, {
                  retentionPolicy: policy as unknown as Record<string, unknown>,
                });
                if (res?.error) {
                  toast.error(res.error);
                  return;
                }
                markDraftDirty();
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

        {level === "PRODUCT" && activeTab === "api" && (
          <ApiTab
            entityId={entity.id}
            entityName={entity.name}
            domainId={entity.domainId}
            serviceId={apiServiceId}
            initialOperations={apiOperations}
            fields={fields.map((f) => ({ name: f.name, type: f.type }))}
            isReadOnly={readOnly_}
          />
        )}
      </div>

      <PublishEntityDialog
        open={publishOpen}
        entityName={entity.name}
        preview={publishPreview}
        loadError={publishLoadError}
        isPublishing={isPublishing}
        publishError={publishError}
        onPickReference={publishPreview && needsReferenceOf(publishPreview.blockers) ? () => void loadPublishPreview() : undefined}
        nested={referenceDialog}
        onOpenChange={setPublishOpen}
        onConfirm={handleConfirmPublish}
      />

      {/* Type Mapping Override Dialog */}
      <TypeMappingOverrideDialog
        open={overrideDialogOpen}
        onClose={() => setOverrideDialogOpen(false)}
        mappingContext={null}
        entityId={entity.id}
        userRole="STEWARD"
        onCreateOverride={handleCreateOverride}
        onAcknowledge={handleAcknowledge}
      />
    </div>
    </>
  );
}
