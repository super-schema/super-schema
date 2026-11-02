"use client";

import { useState, useEffect, useTransition, useCallback, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Upload } from "lucide-react";
import { GenerationIcon } from "@/components/icons/feature-icons";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnsavedChangesDialog } from "@/features/events/builder/UnsavedChangesDialog";
import { useLeaveGuard, type PendingLeave } from "@/features/events/builder/use-leave-guard";
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
  setFieldReferenceAction,
  reorderFieldsAction,
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
import { errorMessage } from "@/lib/error-message";
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
import { NO_ENTITY_CAPABILITIES, type EntityCapabilities } from "@/lib/access/capabilities";
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
import { useTransientFlag } from "@/hooks/useTransientFlag";
import type { ReferenceFieldControls } from "./components/ReferencePinControl";
import type { EntityVersionSummary, PublishInput } from "@/lib/entity-versioning/types";
import type { PickableEntity } from "@/lib/references/entity-reference";
import type { DraftVersionState } from "@/lib/entity-versioning/draft-label";
import { pluralize } from "@/lib/pluralize";
type EntityStatus = "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED";
type ViewTab = "editor" | "versions" | "governance" | "alerts" | "schemas" | "api" | "deployments" | "typespec";
type RightPanelTab = "field-edit" | "typespec-preview";

const VIEW_GROUPS = [
  { label: "Author", tabs: [["editor", "Editor"], ["typespec", "TypeSpec source"]] },
  { label: "Deliver", tabs: [["schemas", "Schemas"], ["api", "API"], ["deployments", "Deployments"]] },
  { label: "Govern", tabs: [["governance", "Governance"], ["alerts", "Alerts"]] },
  { label: "History", tabs: [["versions", "Versions"]] },
] satisfies Array<{ label: string; tabs: Array<[ViewTab, string]> }>;

function normalizeView(value: string | null, level: "TENANT" | "PRODUCT"): ViewTab {
  if (value === "api" && level !== "PRODUCT") return "editor";
  return VIEW_GROUPS.some((group) => group.tabs.some(([id]) => id === value)) ? value as ViewTab : "editor";
}

/**
 * An editor's unsaved edits as the page sees them: `dirty` (state, so the guard renders from it), `dirtyRef` (what the handlers that run outside a
 * render read), and the save and discard the guard's dialog calls, which the editor registers through `saveRef` / `discardRef`.
 */
function useEditorDraft() {
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => {
    setDirty(value);
    dirtyRef.current = value;
  }, []);
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);
  const discardRef = useRef<(() => void) | null>(null);
  return useMemo(() => ({ dirty, dirtyRef, onDirtyChange, saveRef, discardRef }), [dirty, onDirtyChange]);
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
  /**
   * The entities of the tenant a reference field can point at, with their domain and product, for the type picker's reference prompt.
   * Optional so loaders and tests that predate it still compile; absent leaves `reference` a plain type change.
   */
  referenceTargets?: PickableEntity[];
  /**
   * What the signed-in user may do with this entity, decided by the server's policy (`entityCapabilities`), never from a role name. A hint
   * for the controls only: every action re-checks on the server. Absent reads as nothing allowed (fail closed).
   */
  capabilities?: EntityCapabilities;
}

export function EntityWorkspace({ level, entity, fields, domainPolicy, apiServiceId, apiOperations, replacementEntity, referenceStaleness, referenceTargets, capabilities = NO_ENTITY_CAPABILITIES }: EntityWorkspaceProps) {
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
  const [showSaved, flashSaved] = useTransientFlag(2000);

  // Emission state
  const [isEmitting, setIsEmitting] = useState(false);

  // Entity delete state
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeletingEntity, setIsDeletingEntity] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);

  // Version history state
  const [versionHistory, setVersionHistory] = useState<VersionSnapshot[]>([]);

  // Diff viewer state
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // Native history updates keep the view shareable without remounting the workspace.
  const searchParams = useSearchParams();
  const requestedView = normalizeView(searchParams.get("tab"), level);
  const [activeTab, setActiveTab] = useState<ViewTab>(requestedView);
  const activeTabRef = useRef(requestedView);
  const tabsListRef = useRef<HTMLDivElement>(null);

  // Keep the selected tab visible on deep links, view changes and panel resizes.
  useEffect(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const revealSelectedTab = () => {
      const tab = list.querySelector<HTMLElement>(`[data-testid="tab-${activeTab}"]`);
      if (!tab) return;
      const viewport = list.getBoundingClientRect();
      const bounds = tab.getBoundingClientRect();
      if (bounds.left < viewport.left) list.scrollLeft += bounds.left - viewport.left;
      else if (bounds.right > viewport.right) list.scrollLeft += bounds.right - viewport.right;
    };
    revealSelectedTab();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealSelectedTab);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeTab]);

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
  const [legacyLoaded, setLegacyLoaded] = useState(false);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const publishedRequestRef = useRef(0);
  const legacyRequestRef = useRef(0);
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

  // Unsaved edits outside the field panel, guarded like its edits: the TypeSpec source (its tab) and the inline tags, owner and description
  // (above the tabs). Each reports its state and answers the guard's save and discard (see `saveDrafts` and `discardDrafts`).
  const typeSpecDraft = useEditorDraft();
  const metaDraft = useEditorDraft();

  // Refs for keyboard shortcut save/discard delegation
  const fieldSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const fieldDiscardRef = useRef<(() => void) | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingLeave | null>(null);
  const [savingField, setSavingField] = useState(false);
  const [panelSaving, setPanelSaving] = useState(false);
  const panelSavingRef = useRef(false);
  const fieldBusy = savingField || panelSaving;
  const handlePanelSavingChange = useCallback((saving: boolean) => {
    panelSavingRef.current = saving;
    setPanelSaving(saving);
  }, []);
  const [guardError, setGuardError] = useState<string | null>(null);
  // The guard's dialog is saving the other drafts (see `saveDrafts`).
  const [savingDrafts, setSavingDrafts] = useState(false);
  const fieldSaveAttempt = useRef<Promise<boolean> | null>(null);
  // Any unsaved edit on the page keeps the guard up: its questions for navigation and its reload prompt.
  const hasUnsavedEdits = isFieldDirty || typeSpecDraft.dirty || metaDraft.dirty;
  const { pending: pendingLeave } = useLeaveGuard(hasUnsavedEdits || fieldBusy, { queryKey: "tab" });
  const pendingDecision = pendingAction ?? pendingLeave;

  const requestAction = useCallback((run: () => void | Promise<void>, destination = "continue") => {
    const execute = () => {
      try { void Promise.resolve(run()).catch((error) => toast.error(errorMessage(error))); }
      catch (error) { toast.error(errorMessage(error)); }
    };
    if (!fieldDirtyRef.current && !typeSpecDraft.dirtyRef.current && !metaDraft.dirtyRef.current && !panelSavingRef.current && !fieldSaveAttempt.current) {
      execute();
      return;
    }
    setGuardError(null);
    let settled = false;
    setPendingAction({
      destination,
      proceed() {
        if (settled) return;
        settled = true;
        setPendingAction(null);
        execute();
      },
      stay() {
        if (settled) return;
        settled = true;
        setPendingAction(null);
      },
    });
  }, [typeSpecDraft, metaDraft]);

  const saveField = useCallback((): Promise<boolean> => {
    if (fieldSaveAttempt.current) return fieldSaveAttempt.current;
    const save = fieldSaveRef.current;
    if (!save) {
      setGuardError("The field editor is not ready. Stay here and try again.");
      return Promise.resolve(false);
    }
    setSavingField(true);
    setGuardError(null);
    const attempt = (async () => {
      try {
        if (await Promise.resolve().then(save) !== true) {
          setGuardError("The field could not be saved, or newer edits remain. Stay to review your edits, or retry saving.");
          return false;
        }
        handleFieldDirtyChange(false);
        return true;
      } catch (error) {
        setGuardError(`Could not save the field: ${errorMessage(error)}`);
        return false;
      } finally {
        fieldSaveAttempt.current = null;
        setSavingField(false);
      }
    })();
    fieldSaveAttempt.current = attempt;
    return attempt;
  }, [handleFieldDirtyChange]);

  const discardField = useCallback(() => {
    if (panelSavingRef.current || fieldSaveAttempt.current) {
      setGuardError("Wait for the current save to finish before discarding edits.");
      return false;
    }
    if (fieldDirtyRef.current && !fieldDiscardRef.current) {
      setGuardError("The field editor is not ready. Stay here and try again.");
      return false;
    }
    fieldDiscardRef.current?.();
    handleFieldDirtyChange(false);
    setGuardError(null);
    return true;
  }, [handleFieldDirtyChange]);

  // The guard's dialog saves every unsaved editor of the page: the field panel, then the TypeSpec source, then the inline details. False when
  // one of them could not be saved: the dialog stays, with the message.
  const saveDrafts = useCallback(async (): Promise<boolean> => {
    setSavingDrafts(true);
    try {
      if (fieldDirtyRef.current && !(await saveField())) return false;
      const drafts = [
        { draft: typeSpecDraft, failure: "The TypeSpec source could not be saved. Stay to review your edits, or retry saving." },
        { draft: metaDraft, failure: "The tags, owner or description could not be saved. Stay to review your edits, or retry saving." },
      ];
      for (const { draft, failure } of drafts) {
        if (draft.dirtyRef.current && !(await draft.saveRef.current?.())) {
          setGuardError(failure);
          return false;
        }
      }
      return true;
    } finally {
      setSavingDrafts(false);
    }
  }, [saveField, typeSpecDraft, metaDraft]);

  // Discards every unsaved editor of the page, the same choice for each. False when the field panel could not drop its edits (a save is running).
  const discardDrafts = useCallback((): boolean => {
    if (fieldDirtyRef.current && !discardField()) return false;
    for (const draft of [typeSpecDraft, metaDraft]) {
      if (!draft.dirtyRef.current) continue;
      draft.discardRef.current?.();
      draft.onDirtyChange(false);
    }
    return true;
  }, [discardField, typeSpecDraft, metaDraft]);

  const applyView = useCallback((tab: ViewTab, history: "push" | "replace" | "none" = "replace") => {
    activeTabRef.current = tab;
    setActiveTab(tab);
    if (tab !== "editor") setRightPanelTab("typespec-preview");
    if (history !== "none") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      // Next copies its internal state itself; passing __NA/_N would bypass useSearchParams synchronization.
      if (url.href !== window.location.href) window.history[history === "push" ? "pushState" : "replaceState"](null, "", url);
    }
  }, []);

  // The leave guard cancels view traversals before the history index moves. Stay never rewrites a traversed entry.
  useEffect(() => {
    if (requestedView !== activeTabRef.current && !hasUnsavedEdits && !fieldBusy) applyView(requestedView, "none");
  }, [requestedView, hasUnsavedEdits, fieldBusy, applyView]);

  const selectedField = selectedFieldId
    ? fields.find((f) => f.id === selectedFieldId) ?? null
    : null;

  const handleFieldSelect = useCallback((fieldId: string) => {
    if (fieldId === selectedFieldId && activeTab === "editor" && rightPanelTab === "field-edit") return;
    requestAction(() => {
      applyView("editor");
      setSelectedFieldId(fieldId);
      setRightPanelTab("field-edit");
    });
  }, [selectedFieldId, activeTab, rightPanelTab, requestAction, applyView]);

  const handleRightPanelTabChange = useCallback((tab: RightPanelTab) => {
    if (tab === rightPanelTab) return;
    requestAction(() => {
      if (tab === "field-edit") applyView("editor");
      setRightPanelTab(tab);
    });
  }, [rightPanelTab, requestAction, applyView]);

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
      throw new Error(result.error);
    }
    markDraftDirty();
    flashSaved();
  }, [flashSaved, markDraftDirty]);

  // The pin control of reference fields: what can be pinned (the referenced entity's PUBLISHED versions) and the write (a pin, or null
  // to remove it). A pin is a draft change like any other edit of the field.
  const referenceControls = useMemo<ReferenceFieldControls>(
    () => ({
      listPublishedVersions: async (referencedEntityId) => {
        const res = await listEntityVersionsAction(referencedEntityId);
        return "error" in res ? { error: res.error } : { labels: res.versions.map((v) => v.label) };
      },
      setPin: async ({ fieldId, referencedEntityId, pinnedVersion }) => {
        const res = await setFieldReferenceAction(entity.id, fieldId, { entityId: referencedEntityId, pinnedVersion });
        if (!res.success) return { error: res.error.message };
        setTypeSpecTrigger((n) => n + 1);
        markDraftDirty();
        flashSaved();
        return undefined;
      },
    }),
    [entity.id, markDraftDirty, flashSaved]
  );

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

  const emitSavedDraft = useCallback(async () => {
    setIsEmitting(true);
    try {
      // A name that two entities answer to is asked about (the same pick dialog a generation opens), and the emission runs again.
      const response = await resolveReferences(() => emitEntityAction(entity.id));
      if (response === null) return; // the user cancelled the pick
      if ("error" in response && response.error) {
        toast.error(response.error);
        return;
      }
      if ("result" in response && response.result) {
        const { summary } = response.result;
        if (response.result.refusal) {
          // The closure could not be built (and no question is left to ask): say why, not "N targets invalid".
          toast.error(response.result.refusal.message);
        } else if (summary.invalidCount === 0 && summary.warningCount === 0) {
          toast.success(`Emitted to ${pluralize(summary.totalTargets, "target")} — all valid`);
        } else if (summary.invalidCount === 0) {
          toast.warning(
            `Emitted to ${pluralize(summary.totalTargets, "target")} — ${pluralize(summary.warningCount, "warning")}`
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
  }, [entity.id, resolveReferences]);

  const handleEmit = useCallback(() => {
    requestAction(emitSavedDraft, "generate");
  }, [requestAction, emitSavedDraft]);

  const loadPublishedHistory = useCallback(async () => {
    const request = ++publishedRequestRef.current;
    setVersionsLoaded(false);
    setVersionsError(null);
    try {
      const result = await listEntityVersionsAction(entity.id);
      if (request !== publishedRequestRef.current) return;
      if ("error" in result) setVersionsError(result.error);
      else setPublishedVersions(result.versions);
    } catch (error) {
      if (request === publishedRequestRef.current) setVersionsError(errorMessage(error));
    } finally {
      if (request === publishedRequestRef.current) setVersionsLoaded(true);
    }
  }, [entity.id]);

  const loadLegacyHistory = useCallback(async () => {
    const request = ++legacyRequestRef.current;
    setLegacyLoaded(false);
    setLegacyError(null);
    try {
      const result = await getVersionHistoryAction(entity.id);
      if (request !== legacyRequestRef.current) return;
      if ("error" in result) setLegacyError(result.error);
      else if (result.versions) setVersionHistory(result.versions as VersionSnapshot[]);
      else setLegacyError("The history response was incomplete. Try again.");
    } catch (error) {
      if (request === legacyRequestRef.current) setLegacyError(errorMessage(error));
    } finally {
      if (request === legacyRequestRef.current) setLegacyLoaded(true);
    }
  }, [entity.id]);

  const handleOpenHistory = useCallback(async () => {
    await Promise.all([loadPublishedHistory(), loadLegacyHistory()]);
  }, [loadPublishedHistory, loadLegacyHistory]);

  useEffect(() => {
    if (activeTab === "versions") void handleOpenHistory();
  }, [activeTab, handleOpenHistory]);

  // Loads the publish preview. An ambiguous reference that blocks it is asked right away (the pick dialog opens over the publish dialog,
  // the pick is saved on the entity + field that hold the reference, often a member of the closure) and the preview is loaded again.
  // Cancelling leaves the blocker listed, with a button to choose.
  const loadPublishPreview = useCallback(async () => {
    setPublishLoadError(null);
    setPublishPreview(null);
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

  const handleOpenPublish = useCallback(() => {
    requestAction(async () => {
      setPublishOpen(true);
      setPublishPreview(null);
      setPublishError(null);
      await loadPublishPreview();
    }, "publish");
  }, [requestAction, loadPublishPreview]);

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
      requestAction(async () => {
        await handleCompare(previousVersion, versionNumber);
        applyView("editor");
      });
    },
    [handleCompare, requestAction, applyView]
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
    if (isDeletingEntity) return;
    setIsDeletingEntity(true);
    setDeleteError(null);
    try {
      const result = await deleteEntityAction(entity.id);
      if (result.error) {
        setDeleteError(result.error);
        toast.error(result.error);
      } else {
        setDeleteConfirmOpen(false);
        toast.success(`"${entity.name}" deleted`);
        void invalidateDomainsTree(); // the explorer reads a cached tree: without this the deleted entity row stays until a reload
        router.push(
          entity.domainSlug && entity.productSlug
            ? assetHref({ kind: "product", domainSlug: entity.domainSlug, productSlug: entity.productSlug })
            : assetHref({ kind: "enterprise" })
        );
      }
    } catch (error) {
      setDeleteError(`Failed to delete entity: ${errorMessage(error)}`);
      toast.error("Failed to delete entity");
    } finally {
      setIsDeletingEntity(false);
    }
  }, [isDeletingEntity, entity.id, entity.name, entity.domainSlug, entity.productSlug, router, invalidateDomainsTree]);

  // Metadata save (tags / owner) — updates the draft only (spec D1).
  const handleMetaSaved = useCallback(() => {
    markDraftDirty();
    flashSaved();
  }, [flashSaved, markDraftDirty]);

  const handleTabChange = useCallback((tab: ViewTab) => {
    const next = normalizeView(tab, level);
    if (next === activeTabRef.current) return;
    requestAction(() => applyView(next));
  }, [level, requestAction, applyView]);

  // Escape belongs to the active overlay; it never resets field edits.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!readOnly_ && !isEmitting && !fieldBusy) handleEmit();
      }
      if (e.key.toLowerCase() === "s" && activeTab === "editor") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!readOnly_ && fieldDirtyRef.current) void saveField();
      }
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleEmit, saveField, readOnly_, isEmitting, fieldBusy, activeTab]);

  // Navigation guard: beforeunload when any editor has unsaved edits
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (fieldDirtyRef.current || typeSpecDraft.dirtyRef.current || metaDraft.dirtyRef.current) {
        e.preventDefault();
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [typeSpecDraft, metaDraft]);

  const unsavedWhat = typeSpecDraft.dirty || metaDraft.dirty ? "This entity has unsaved edits." : "This field has unsaved edits.";

  return (
    <>
    <UnsavedChangesDialog
      pending={pendingDecision}
      saving={fieldBusy || savingDrafts}
      error={guardError}
      description={pendingDecision?.destination === "generate"
        ? `${unsavedWhat} Save them before generating schemas, or discard them to generate from the saved draft.`
        : `${unsavedWhat} Save them before continuing, discard them, or stay here.`}
      saveLabel={pendingDecision?.destination === "generate" ? "Save and generate" : "Save and continue"}
      discardLabel={pendingDecision?.destination === "generate" ? "Discard and generate" : "Discard and continue"}
      onSaveAndLeave={saveDrafts}
      onDiscardAndLeave={discardDrafts}
      onStay={() => { if (!fieldBusy && !savingDrafts) { pendingDecision?.stay(); setGuardError(null); } }}
    />
    <Dialog
      open={deleteConfirmOpen}
      disablePointerDismissal={isDeletingEntity}
      onOpenChange={(open) => { if (!isDeletingEntity) setDeleteConfirmOpen(open); }}
    >
      <DialogContent initialFocus={deleteCancelRef} finalFocus={deleteReturnFocusRef} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{entity.name}&rdquo;?</DialogTitle>
          <DialogDescription>Permanently deletes this entity and all its fields. This action cannot be undone.</DialogDescription>
        </DialogHeader>
        {deleteError && <p role="alert" className="text-body-small text-destructive">{deleteError}</p>}
        <DialogFooter>
          <Button ref={deleteCancelRef} type="button" variant="outline" size="sm" onClick={() => setDeleteConfirmOpen(false)} disabled={isDeletingEntity}>Cancel</Button>
          <Button type="button" variant="destructive" size="sm" onClick={handleDeleteEntity} disabled={isDeletingEntity}>{isDeletingEntity ? "Deleting…" : "Delete"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
            onDelete={readOnly_ ? undefined : () => {
              deleteReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              setDeleteError(null);
              setDeleteConfirmOpen(true);
            }}
          />
        }
      />

      <div className="mb-space-4 flex flex-wrap items-center justify-between gap-space-3 rounded-lg border border-border px-space-3 py-space-2">
        <p role="status" aria-live="polite" data-testid="workspace-draft-status" className="text-body-small text-muted-foreground">
          {fieldBusy ? "Saving field edits…" : isFieldDirty ? "Unsaved field edits" : typeSpecDraft.dirty ? "Unsaved TypeSpec source edits" : metaDraft.dirty ? "Unsaved tag, owner or description edits" : versionState.hasUnpublishedChanges ? "Draft saved · unpublished changes" : versionState.latestVersionLabel ? `Published v${versionState.latestVersionLabel} · draft up to date` : "Draft saved · not published"}
        </p>
        {!readOnly_ && <Button type="button" variant="outline" size="sm" onClick={handleEmit} disabled={isEmitting || fieldBusy}>
          <GenerationIcon data-icon="inline-start" aria-hidden="true" />{isEmitting ? "Generating…" : "Generate schemas"}
        </Button>}
      </div>

      {/* Inline entity metadata */}
      <InlineEntityMeta
        entity={entity}
        isReadOnly={readOnly_}
        onGovernanceClick={() => handleTabChange("governance")}
        onMetaSaved={handleMetaSaved}
        onDirtyChange={metaDraft.onDirtyChange}
        saveRef={metaDraft.saveRef}
        discardRef={metaDraft.discardRef}
      />

      {/* Right panel router (renders nothing itself, pushes content via context) */}
      <RightPanelRouter
        selectedField={selectedField}
        entityId={entity.id}
        entitySlug={entity.slug}
        domainSlug={entity.domainSlug}
        isReadOnly={readOnly_}
        rightPanelTab={rightPanelTab}
        onTabChange={handleRightPanelTabChange}
        onUpdateField={handleUpdateField}
        typeSpecTrigger={typeSpecTrigger}
        existingFields={fields.map((f) => ({
          name: f.name,
          type: f.type,
          isOptional: f.nullable,
          isKey: f.isKey,
        }))}
        onTypeSpecApplied={() => {
          markDraftDirty();
          flashSaved();
          setTypeSpecTrigger((n) => n + 1);
          router.refresh();
        }}
        onDirtyChange={handleFieldDirtyChange}
        onSavingChange={handlePanelSavingChange}
        fieldSaveRef={fieldSaveRef}
        fieldDiscardRef={fieldDiscardRef}
        referenceTargets={referenceTargets}
      />

      <Tabs value={activeTab} onValueChange={(value) => handleTabChange(value as ViewTab)} className="min-w-0">
        <TabsList ref={tabsListRef} variant="line" aria-label="Entity workspace views" className="mb-space-4 h-auto w-full min-w-0 flex-nowrap justify-start gap-space-1 overflow-x-auto border-b border-border pb-space-2 group-data-horizontal/tabs:h-auto">
          {VIEW_GROUPS.flatMap<[ViewTab, string]>((group) => group.tabs).filter(([tab]) => level === "PRODUCT" || tab !== "api").map(([tab, label]) => (
            <TabsTrigger key={tab} value={tab} data-testid={`tab-${tab}`} data-alert-count={tab === "alerts" ? alertCount : undefined} className="min-h-9 flex-none px-space-3">
              {label}{tab === "alerts" && alertCount > 0 ? ` (${alertCount})` : ""}
            </TabsTrigger>
          ))}
        </TabsList>

      {/* Center Panel */}
      <TabsContent key={activeTab} value={activeTab} className="mb-space-8 min-w-0">
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
                referenceControls={referenceControls}
                referenceTargets={referenceTargets}
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
                onReorderFields={async (orderedIds) => {
                  try {
                    const result = await reorderFieldsAction(entity.id, orderedIds);
                    if (result.error) {
                      toast.error(result.error);
                      // The page may hold an older list (a field added or removed elsewhere): reload it, so the shown order is the stored one.
                      router.refresh();
                      return false;
                    }
                    setTypeSpecTrigger((n) => n + 1);
                    markDraftDirty();
                    return true;
                  } catch {
                    toast.error("Could not change the field order. Try again.");
                    // The save may have been written before it failed (the audit entry did not go through): reload to show the stored order.
                    router.refresh();
                    return false;
                  }
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
          <TypeSpecSourceTab
            entityId={entity.id}
            entityName={entity.name}
            readOnly={readOnly_}
            onDirtyChange={typeSpecDraft.onDirtyChange}
            saveRef={typeSpecDraft.saveRef}
            discardRef={typeSpecDraft.discardRef}
            onSaved={() => {
              markDraftDirty();
              // Refresh data while preserving the source tab, selected field and URL.
              setTypeSpecTrigger((n) => n + 1);
              router.refresh();
            }}
          />
        )}

        {activeTab === "versions" && (
          <div className="space-y-space-6" data-testid="versions-tab">
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
              <div className="flex flex-col items-start gap-space-2">
                <p role="alert" data-testid="versions-error" className="text-body-small text-destructive">Could not load published versions: {versionsError}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void loadPublishedHistory()}>Retry published versions</Button>
              </div>
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
              {legacyError ? (
                <div className="flex flex-col items-start gap-space-2">
                  <p role="alert" data-testid="legacy-history-error" className="text-body-small text-destructive">Could not load legacy history: {legacyError}</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => void loadLegacyHistory()}>Retry legacy history</Button>
                </div>
              ) : !legacyLoaded ? (
                <p role="status" className="text-body-small text-muted-foreground">Loading legacy history…</p>
              ) : versionHistory.length > 0 ? (
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
          <div className="space-y-space-6" data-testid="governance-tab">
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
          <div className="space-y-space-6" data-testid="alerts-tab">
            <h2 className="text-heading-2 text-foreground">Alerts</h2>
            <AlertsTab
              alerts={entityAlerts}
              onNavigateToField={handleFieldSelect}
              onNavigateToTab={(tab) => handleTabChange(normalizeView(tab, level))}
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
      </TabsContent>
      </Tabs>

      <PublishEntityDialog
        consumerPreview={<UsedByPanel subject={{ kind: "entity", entityId: entity.id }} title="Consumers to review" emptyText="No visible references were found for this entity." />}
        onRetry={() => void loadPublishPreview()}
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
      {/* The same pick dialog, when the question comes from the all-targets emission (the publish dialog is not open to host it). */}
      {!publishOpen && referenceDialog}

      {/* Type Mapping Override Dialog */}
      <TypeMappingOverrideDialog
        open={overrideDialogOpen}
        onClose={() => setOverrideDialogOpen(false)}
        mappingContext={null}
        entityId={entity.id}
        capabilities={capabilities}
        onCreateOverride={handleCreateOverride}
        onAcknowledge={handleAcknowledge}
      />
    </div>
    </>
  );
}
