"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Building2, Globe, Plus, Settings2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApiOperation, ApiOperationRecord } from "@/types/schemas/api-operation";
import type { ApiOperationIssue } from "@/lib/api-operations/validate";
import {
  createOperationAction,
  deleteOperationAction,
  getOrCreateEntityServiceAction,
  reorderOperationsAction,
  updateServiceAction,
} from "../../../actions";
import {
  crudKey,
  crudOperations,
  draftWarnings,
  duplicateOperation,
  mergeWarnings,
  missingCrudOperations,
  moveId,
  recordFromOperation,
  typeOptionGroups,
  validateDraft,
  type OperationDraft,
} from "./api-tab-model";
import { useOperationAutosave } from "./useOperationAutosave";
import { ApiOperationRow } from "./ApiOperationEditor";
import { ApiNewOperationForm } from "./ApiNewOperationForm";
import { ApiServiceSettings, type ApiServiceInfo } from "./ApiServiceSettings";
import { SaveIndicator } from "./ApiFormControls";
import { ApiImportDialog } from "./ApiImportDialog";

// The preview renders the emitted OpenAPI document (heavy): loaded only when the Preview view is opened.
const ApiPreview = dynamic(() => import("./ApiPreview").then((m) => m.ApiPreview), {
  ssr: false,
  loading: () => <p className="text-caption text-muted-foreground py-6 text-center">Loading preview…</p>,
});

/** A stored operation as the entity page loader hands it over (the contract shape, `records.ts`). */
export type ApiOperationData = ApiOperationRecord;

interface ApiTabProps {
  entityId: string;
  entityName: string;
  /** null for tenant-level entities, which cannot host an API service. */
  domainId: string | null;
  serviceId: string | null;
  /** The entity's API service (name, base path), when it has one. */
  service?: ApiServiceInfo | null;
  initialOperations: ApiOperationData[];
  fields: { name: string; type: string; isKey?: boolean }[];
  /** Other entity / data-type names the type pickers offer (beyond primitives and this entity). */
  typeNames?: string[];
  isReadOnly?: boolean;
}

type ServiceResult = { success: true; serviceId: string } | { success?: undefined; error: string };
type View = "operations" | "preview";

const NO_ISSUES: ApiOperationIssue[] = [];
const NO_WARNINGS: readonly string[] = [];

/** A created operation: the stored record plus the save's warnings (stored, but not generated as written). */
type Created = { record: OperationDraft; warnings: string[] };

export function ApiTab({
  entityId,
  entityName,
  domainId,
  serviceId: initialServiceId,
  service: initialService = null,
  initialOperations,
  fields,
  typeNames = [],
  isReadOnly = false,
}: ApiTabProps) {
  const [serviceId, setServiceId] = useState(initialServiceId);
  const [service, setService] = useState<ApiServiceInfo | null>(initialService);
  const [operations, setOperations] = useState<OperationDraft[]>(initialOperations);
  const [serverIssues, setServerIssues] = useState<Record<string, ApiOperationIssue[]>>({});
  const [serverWarnings, setServerWarnings] = useState<Record<string, string[]>>({});
  const [expandedOp, setExpandedOp] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<View>("operations");
  const [generating, setGenerating] = useState(false);
  // False while the pending edits are being saved before the preview (which reads what is stored) is mounted.
  const [previewReady, setPreviewReady] = useState(true);

  // The latest operations, readable from timers and handlers. Written only in event handlers (never during render, never in
  // a state updater): side effects must never run inside a setState updater, which executes during render.
  const operationsRef = useRef(operations);
  const serviceIdRef = useRef(serviceId);

  /** Replace the operation list: ref first (timers read it), then state. */
  const commit = useCallback((next: OperationDraft[]) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const getDraft = useCallback((id: string) => operationsRef.current.find((o) => o.id === id), []);
  const validate = useCallback((draft: OperationDraft) => validateDraft(draft, operationsRef.current), []);
  const onIssues = useCallback((id: string, issues: ApiOperationIssue[]) => {
    setServerIssues((prev) => {
      if (!issues.length && !prev[id]) return prev;
      const next = { ...prev };
      if (issues.length) next[id] = issues;
      else delete next[id];
      return next;
    });
  }, []);
  // Warnings of the last save of each operation. Shown inline (they never block a save); the client already derives the
  // known ones from the draft (`draftWarnings`), so an autosave adds no toast, only what the server knows beyond them.
  const onWarnings = useCallback((id: string, warnings: string[]) => {
    setServerWarnings((prev) => {
      if (!warnings.length && !prev[id]) return prev;
      const next = { ...prev };
      if (warnings.length) next[id] = warnings;
      else delete next[id];
      return next;
    });
  }, []);
  const autosave = useOperationAutosave({ getDraft, validate, onIssues, onWarnings });
  const { schedule, cancel, track, flushAll } = autosave;

  // Keyed by content: the parent passes freshly mapped arrays on every render, and a stable `groups` keeps the rows memoized.
  const typeKey = [...typeNames, ...fields.map((f) => f.type)].join("\n");
  const groups = useMemo(() => typeOptionGroups(entityName, typeKey ? typeKey.split("\n") : []), [entityName, typeKey]);

  // Client issues of every draft, siblings included (duplicate method + path is a sibling rule).
  const clientIssues = useMemo(() => {
    const out: Record<string, ApiOperationIssue[]> = {};
    for (const op of operations) {
      const issues = validateDraft(op, operations);
      if (issues.length) out[op.id] = issues;
    }
    return out;
  }, [operations]);

  // Save-time warnings of every draft: the client-derived ones, then any the server's last save added.
  const warningsById = useMemo(() => {
    const out: Record<string, readonly string[]> = {};
    for (const op of operations) {
      const warnings = mergeWarnings(draftWarnings(op), serverWarnings[op.id]);
      if (warnings.length) out[op.id] = warnings;
    }
    return out;
  }, [operations, serverWarnings]);

  /** Apply an edit to one operation: a pure state update, then the debounced save, both from the event handler. */
  const edit = useCallback((next: OperationDraft) => {
    commit(operationsRef.current.map((o) => (o.id === next.id ? next : o)));
    onIssues(next.id, []);
    schedule(next.id);
  }, [commit, onIssues, schedule]);

  /** The entity's service id, created on first use. Null (and a toast) when it cannot be had. */
  const ensureService = useCallback(async (): Promise<string | null> => {
    if (serviceIdRef.current) return serviceIdRef.current;
    if (!domainId) {
      toast.error("Place this entity in a product before adding API operations.");
      return null;
    }
    const result = (await track(() => getOrCreateEntityServiceAction(domainId, entityId, entityName) as Promise<ServiceResult>)) as ServiceResult | undefined;
    if (!result || "error" in result) {
      if (result) toast.error(result.error);
      return null;
    }
    serviceIdRef.current = result.serviceId;
    setServiceId(result.serviceId);
    setService((s) => s ?? { id: result.serviceId, name: `${entityName}Api`, basePath: "/" });
    return result.serviceId;
  }, [domainId, entityId, entityName, track]);

  /**
   * Create one operation on the service; the stored record and the save's warnings, or the server's issues. The warnings are
   * toasted (a create is one deliberate action) and kept for the row's inline notice.
   */
  const createOne = useCallback(async (sid: string, op: ApiOperation): Promise<Created | ApiOperationIssue[]> => {
    const result = await track(() => createOperationAction(sid, op));
    if (!result) return [{ path: "", message: "The operation could not be created." }];
    if (!result.success) {
      return result.issues?.length ? result.issues : [{ path: "", message: result.error }];
    }
    const record = recordFromOperation(result.operationId, sid, result.operation);
    const warnings = result.warnings ?? [];
    for (const w of warnings) toast.warning(`${record.name}: ${w}`);
    onWarnings(record.id, warnings);
    return { record, warnings };
  }, [onWarnings, track]);

  const addOperation = useCallback(async (op: ApiOperation): Promise<ApiOperationIssue[]> => {
    const sid = await ensureService();
    if (!sid) return [{ path: "", message: "No API service is available for this entity." }];
    const created = await createOne(sid, op);
    if (Array.isArray(created)) return created;
    commit([...operationsRef.current, created.record]);
    setExpandedOp(created.record.id);
    setIsAdding(false);
    return [];
  }, [commit, createOne, ensureService]);

  const generateCrud = useCallback(async () => {
    const todo = missingCrudOperations(operationsRef.current, crudOperations(entityName, crudKey(fields)));
    if (todo.length === 0) {
      toast.info("All CRUD operations already exist.");
      return;
    }
    setGenerating(true);
    try {
      const sid = await ensureService();
      if (!sid) return;
      let added = 0;
      for (const op of todo) {
        const created = await createOne(sid, op);
        if (Array.isArray(created)) {
          toast.error(`${op.name}: ${created[0]?.message ?? "could not be created"}`);
          continue;
        }
        commit([...operationsRef.current, created.record]);
        added++;
      }
      if (added) toast.success(`Added ${added} CRUD operation${added === 1 ? "" : "s"}.`);
    } finally {
      setGenerating(false);
    }
  }, [commit, createOne, ensureService, entityName, fields]);

  const duplicate = useCallback(async (id: string) => {
    const source = operationsRef.current.find((o) => o.id === id);
    const sid = serviceIdRef.current;
    if (!source || !sid) return;
    const created = await createOne(sid, duplicateOperation(source, operationsRef.current));
    if (Array.isArray(created)) {
      toast.error(created[0]?.message ?? "The operation could not be duplicated.");
      return;
    }
    commit([...operationsRef.current, created.record]);
    setExpandedOp(created.record.id);
  }, [commit, createOne]);

  const remove = useCallback((id: string) => {
    cancel(id);
    commit(operationsRef.current.filter((o) => o.id !== id));
    onIssues(id, []);
    onWarnings(id, []);
    setExpandedOp((cur) => (cur === id ? null : cur));
    void track(() => deleteOperationAction(id)).then((result) => {
      if (result && "error" in result && result.error) toast.error(result.error);
    });
  }, [cancel, commit, onIssues, onWarnings, track]);

  const move = useCallback((id: string, direction: -1 | 1) => {
    const order = moveId(operationsRef.current.map((o) => o.id), id, direction);
    const byId = new Map(operationsRef.current.map((o) => [o.id, o]));
    commit(order.map((oid) => byId.get(oid)!));
    const sid = serviceIdRef.current;
    if (!sid) return;
    void track(() => reorderOperationsAction(sid, order)).then((result) => {
      if (result && "error" in result && result.error) toast.error(result.error);
    });
  }, [commit, track]);

  const onDuplicate = useCallback((id: string) => void duplicate(id), [duplicate]);

  const toggle = useCallback((id: string) => setExpandedOp((cur) => (cur === id ? null : id)), []);

  const onImported = useCallback((ops: ApiOperationRecord[]) => {
    if (ops.length === 0) return;
    if (!serviceIdRef.current) {
      // The import created the entity's service (same default name as `getOrCreateEntityServiceAction`).
      const sid = ops[0].serviceId;
      serviceIdRef.current = sid;
      setServiceId(sid);
      setService((s) => s ?? { id: sid, name: `${entityName}Api`, basePath: "/" });
    }
    const known = new Set(operationsRef.current.map((o) => o.id));
    commit([...operationsRef.current, ...ops.filter((o) => !known.has(o.id))]);
  }, [commit, entityName]);

  const saveService = useCallback(async (changes: { name: string; basePath: string }) => {
    if (!service) return "No API service yet.";
    const result = await track(() => updateServiceAction(service.id, changes));
    if (!result) return "Save failed.";
    if ("error" in result && result.error) return result.error;
    if ("service" in result) setService(result.service);
    return null;
  }, [service, track]);

  const openPreview = useCallback(() => {
    // The preview reads what is stored: pending edits are saved first, and the preview is mounted (and fetches) only after.
    setView("preview");
    setPreviewReady(false);
    void flushAll().finally(() => setPreviewReady(true));
  }, [flushAll]);

  // Tenant-level (Enterprise) entities have no product and therefore no API service.
  if (!domainId) {
    return (
      <div className="space-y-space-4" data-testid="api-tab">
        <h2 className="text-heading-2 text-foreground">API Operations</h2>
        <div data-testid="api-tenant-level" className="flex items-start gap-3 rounded-lg border border-border/50 bg-muted/20 p-space-4">
          <Building2 className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-body-small font-medium text-foreground">API operations are defined on product entities</p>
            <p className="text-caption text-muted-foreground mt-0.5">
              {entityName} lives at the Enterprise level, so it cannot own an API service. Move it into a product to define REST endpoints for it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const tabButton = (v: View, label: string, onClick: () => void) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      data-testid={`api-view-${v}`}
      onClick={onClick}
      className={cn(
        "px-2.5 h-7 text-caption rounded-md transition-colors",
        view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-space-4" data-testid="api-tab">
      <div className="flex flex-wrap items-start justify-between gap-space-2">
        <div className="min-w-0">
          <h2 className="text-heading-2 text-foreground">API Operations</h2>
          <p className="text-caption text-muted-foreground mt-0.5">
            Define REST endpoints for {entityName}
            {service && (
              <span className="ml-1 font-mono text-muted-foreground/70">· {service.name} {service.basePath !== "/" ? service.basePath : ""}</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SaveIndicator status={autosave.status} />
          <div role="tablist" aria-label="API view" className="inline-flex items-center rounded-lg bg-muted p-0.5">
            {tabButton("operations", "Operations", () => setView("operations"))}
            {tabButton("preview", "Preview", openPreview)}
          </div>
          {service && (
            <Button variant="ghost" size="sm" className="gap-1" data-testid="api-service-settings-toggle" aria-expanded={showSettings} onClick={() => setShowSettings((s) => !s)}>
              <Settings2 className="w-3.5 h-3.5" />
              Settings
            </Button>
          )}
          {!isReadOnly && (
            <>
              <ApiImportDialog serviceId={serviceId} domainId={domainId} entityId={entityId} entityName={entityName} onImported={onImported} />
              <Button variant="outline" size="sm" className="gap-1.5" data-testid="api-generate-crud" disabled={generating} onClick={() => void generateCrud()}>
                <Wand2 className="w-3.5 h-3.5" />
                Generate CRUD
              </Button>
              <Button onClick={() => { setView("operations"); setIsAdding(true); }} size="sm" className="gap-1.5" disabled={isAdding} data-testid="api-add-operation">
                <Plus className="w-3.5 h-3.5" />
                Add Operation
              </Button>
            </>
          )}
        </div>
      </div>

      {showSettings && service && (
        <ApiServiceSettings key={`${service.name}|${service.basePath}`} service={service} readOnly={isReadOnly} onSave={saveService} onClose={() => setShowSettings(false)} />
      )}

      {view === "preview" ? (
        // ApiPreview renders its own `api-preview` root; this wrapper has a distinct test id.
        <div data-testid="api-preview-view">
          {previewReady ? <ApiPreview entityId={entityId} /> : <p className="text-caption text-muted-foreground py-6 text-center">Saving pending changes…</p>}
        </div>
      ) : (
        <>
          {isAdding && (
            <ApiNewOperationForm entityName={entityName} siblings={operations} onCreate={addOperation} onCancel={() => setIsAdding(false)} />
          )}

          {operations.length === 0 && !isAdding && (
            <div data-testid="api-empty" className="text-center py-12 text-muted-foreground">
              <Globe className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
              <p className="text-body-small">No API operations defined yet</p>
              <p className="text-caption mt-1">Add operations, generate CRUD endpoints, or import an OpenAPI document</p>
            </div>
          )}

          {operations.map((op, index) => (
            <ApiOperationRow
              key={op.id}
              draft={op}
              index={index}
              count={operations.length}
              expanded={expandedOp === op.id}
              issues={mergeIssues(clientIssues[op.id], serverIssues[op.id])}
              warnings={warningsById[op.id] ?? NO_WARNINGS}
              groups={groups}
              readOnly={isReadOnly}
              onToggle={toggle}
              onChange={edit}
              onDelete={remove}
              onDuplicate={onDuplicate}
              onMove={move}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** Client issues first, then server issues not already reported for the same path and message. */
function mergeIssues(client: ApiOperationIssue[] | undefined, server: ApiOperationIssue[] | undefined): ApiOperationIssue[] {
  if (!client?.length && !server?.length) return NO_ISSUES;
  const seen = new Set((client ?? []).map((i) => `${i.path}\u0000${i.message}`));
  return [...(client ?? []), ...(server ?? []).filter((i) => !seen.has(`${i.path}\u0000${i.message}`))];
}
