"use client";

import { useState, useCallback, useTransition } from "react";
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  getOrCreateEntityServiceAction,
  createOperationAction,
  replaceOperationDetailsAction,
  deleteOperationAction,
} from "../../../actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OperationParam {
  name: string;
  type: string;
  location: "path" | "query" | "header" | "body";
  required: boolean;
  description: string;
}

interface OperationResponse {
  statusCode: number;
  type: string;
  description: string;
}

interface Operation {
  id: string;
  name: string;
  httpMethod: string;
  httpPath: string;
  description: string;
  parameters: OperationParam[];
  responses: OperationResponse[];
}

export interface ApiOperationData {
  id: string;
  serviceId: string;
  name: string;
  httpMethod: string;
  httpPath: string;
  description: string;
  parameters: { name: string; type: string; location: string; required: boolean; description: string }[];
  responses: { statusCode: number; type: string | null; description: string }[];
}

interface ApiTabProps {
  entityId: string;
  entityName: string;
  /** null for tenant-level entities, which cannot host an API service yet. */
  domainId: string | null;
  serviceId: string | null;
  initialOperations: ApiOperationData[];
  fields: { name: string; type: string }[];
  isReadOnly?: boolean;
}

// ---------------------------------------------------------------------------
// HTTP method styling
// ---------------------------------------------------------------------------

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-green-500/15 text-green-600 border-green-500/30",
  POST: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  PUT: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  DELETE: "bg-red-500/15 text-red-600 border-red-500/30",
  PATCH: "bg-purple-500/15 text-purple-600 border-purple-500/30",
};

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const LOCATIONS: OperationParam["location"][] = ["path", "query", "header", "body"];
const COMMON_STATUS_CODES = [200, 201, 204, 400, 401, 403, 404, 500];

function toOperation(data: ApiOperationData): Operation {
  return {
    id: data.id,
    name: data.name,
    httpMethod: data.httpMethod,
    httpPath: data.httpPath,
    description: data.description,
    parameters: data.parameters.map((p) => ({
      name: p.name,
      type: p.type,
      location: p.location as OperationParam["location"],
      required: p.required,
      description: p.description,
    })),
    responses: data.responses.map((r) => ({
      statusCode: r.statusCode,
      type: r.type ?? "",
      description: r.description,
    })),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApiTab({
  entityId,
  entityName,
  domainId,
  serviceId: initialServiceId,
  initialOperations,
  fields,
  isReadOnly = false,
}: ApiTabProps) {
  const [serviceId, setServiceId] = useState(initialServiceId);
  const [operations, setOperations] = useState<Operation[]>(
    initialOperations.map(toOperation)
  );
  const [expandedOp, setExpandedOp] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [, startTransition] = useTransition();

  // New operation form state
  const [newName, setNewName] = useState("");
  const [newMethod, setNewMethod] = useState("GET");
  const [newPath, setNewPath] = useState(`/${entityName.toLowerCase()}s`);
  const [newDesc, setNewDesc] = useState("");

  const persist = useCallback((op: Operation) => {
    startTransition(async () => {
      const result = await replaceOperationDetailsAction(op.id, {
        name: op.name,
        httpMethod: op.httpMethod,
        httpPath: op.httpPath,
        description: op.description,
        parameters: op.parameters,
        responses: op.responses.map((r) => ({ ...r, type: r.type || null })),
      });
      if ("error" in result) toast.error(result.error);
    });
  }, []);

  const addOperation = useCallback(() => {
    if (!newName.trim()) return;

    const parameters: OperationParam[] = [];
    const pathParams = newPath.match(/\{(\w+)\}/g);
    if (pathParams) {
      for (const p of pathParams) {
        parameters.push({
          name: p.replace(/[{}]/g, ""),
          type: "string",
          location: "path",
          required: true,
          description: "",
        });
      }
    }

    const name = newName.trim();
    const httpMethod = newMethod;
    const httpPath = newPath;
    const description = newDesc;

    startTransition(async () => {
      let targetServiceId = serviceId;
      if (!targetServiceId) {
        if (!domainId) {
          toast.error("Place this entity in a product before adding API operations.");
          return;
        }
        const serviceResult = await getOrCreateEntityServiceAction(domainId, entityId, entityName);
        if ("error" in serviceResult) {
          toast.error(serviceResult.error);
          return;
        }
        targetServiceId = serviceResult.serviceId;
        setServiceId(targetServiceId);
      }

      const result = await createOperationAction(targetServiceId, {
        name,
        httpMethod,
        httpPath,
        description,
        parameters,
        responses: [{ statusCode: 200, type: entityName, description: "Successful response" }],
      });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }

      const op: Operation = {
        id: result.operationId,
        name,
        httpMethod,
        httpPath,
        description,
        parameters,
        responses: [{ statusCode: 200, type: entityName, description: "Successful response" }],
      };
      setOperations((prev) => [...prev, op]);
      setExpandedOp(op.id);
    });

    setNewName("");
    setNewMethod("GET");
    setNewPath(`/${entityName.toLowerCase()}s`);
    setNewDesc("");
    setIsAdding(false);
  }, [newName, newMethod, newPath, newDesc, entityName, entityId, domainId, serviceId]);

  const deleteOperation = useCallback((id: string) => {
    setOperations((prev) => prev.filter((o) => o.id !== id));
    if (expandedOp === id) setExpandedOp(null);
    startTransition(async () => {
      const result = await deleteOperationAction(id);
      if ("error" in result) toast.error(result.error);
    });
  }, [expandedOp]);

  const updateOperation = useCallback((id: string, updates: Partial<Operation>) => {
    setOperations((prev) =>
      prev.map((o) => {
        if (o.id !== id) return o;
        const next = { ...o, ...updates };
        persist(next);
        return next;
      })
    );
  }, [persist]);

  const addParam = useCallback((opId: string) => {
    setOperations((prev) =>
      prev.map((o) => {
        if (o.id !== opId) return o;
        const next = { ...o, parameters: [...o.parameters, { name: "", type: "string", location: "query" as const, required: false, description: "" }] };
        persist(next);
        return next;
      })
    );
  }, [persist]);

  const removeParam = useCallback((opId: string, idx: number) => {
    setOperations((prev) =>
      prev.map((o) => {
        if (o.id !== opId) return o;
        const next = { ...o, parameters: o.parameters.filter((_, i) => i !== idx) };
        persist(next);
        return next;
      })
    );
  }, [persist]);

  const updateParam = useCallback((opId: string, idx: number, updates: Partial<OperationParam>) => {
    setOperations((prev) =>
      prev.map((o) => {
        if (o.id !== opId) return o;
        const next = { ...o, parameters: o.parameters.map((p, i) => (i === idx ? { ...p, ...updates } : p)) };
        persist(next);
        return next;
      })
    );
  }, [persist]);

  const addResponse = useCallback((opId: string) => {
    setOperations((prev) =>
      prev.map((o) => {
        if (o.id !== opId) return o;
        const next = { ...o, responses: [...o.responses, { statusCode: 200, type: "", description: "" }] };
        persist(next);
        return next;
      })
    );
  }, [persist]);

  const removeResponse = useCallback((opId: string, idx: number) => {
    setOperations((prev) =>
      prev.map((o) => {
        if (o.id !== opId) return o;
        const next = { ...o, responses: o.responses.filter((_, i) => i !== idx) };
        persist(next);
        return next;
      })
    );
  }, [persist]);

  const updateResponse = useCallback((opId: string, idx: number, updates: Partial<OperationResponse>) => {
    setOperations((prev) =>
      prev.map((o) => {
        if (o.id !== opId) return o;
        const next = { ...o, responses: o.responses.map((r, i) => (i === idx ? { ...r, ...updates } : r)) };
        persist(next);
        return next;
      })
    );
  }, [persist]);

  return (
    <div className="space-y-space-4" data-testid="api-tab">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading-2 text-foreground">API Operations</h2>
          <p className="text-caption text-muted-foreground mt-0.5">
            Define REST endpoints for {entityName}
          </p>
        </div>
        {!isReadOnly && (
          <Button
            onClick={() => setIsAdding(true)}
            size="sm"
            className="gap-1.5"
            disabled={isAdding}
            data-testid="api-add-operation"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Operation
          </Button>
        )}
      </div>

      {/* Add operation form */}
      {isAdding && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-space-4 space-y-space-3">
          <h3 className="text-body-small font-semibold text-foreground">New Operation</h3>
          <div className="grid grid-cols-2 gap-space-2">
            <div>
              <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider block mb-0.5">Name</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                data-testid="api-op-name"
                placeholder="getUser"
                className="h-8 font-mono"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider block mb-0.5">Method</label>
              <select
                data-testid="api-op-method"
                value={newMethod}
                onChange={(e) => setNewMethod(e.target.value)}
                className="h-8 w-full rounded-lg border border-border bg-popover px-2 text-body-small text-foreground"
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider block mb-0.5">Path</label>
            <Input
              value={newPath}
              data-testid="api-op-path"
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/users/{id}"
              className="h-8 font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider block mb-0.5">Description</label>
            <Input
              value={newDesc}
              data-testid="api-op-description"
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Retrieve a user by ID"
              className="h-8"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setIsAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={addOperation} disabled={!newName.trim()} data-testid="api-op-create">
              Create Operation
            </Button>
          </div>
        </div>
      )}

      {/* Operation list */}
      {operations.length === 0 && !isAdding && (
        <div data-testid="api-empty" className="text-center py-12 text-muted-foreground">
          <Globe className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
          <p className="text-body-small">No API operations defined yet</p>
          <p className="text-caption mt-1">Add operations to define REST endpoints for this entity</p>
        </div>
      )}

      {operations.map((op) => {
        const isExpanded = expandedOp === op.id;
        const methodColor = METHOD_COLORS[op.httpMethod] ?? METHOD_COLORS.GET;

        return (
          <div key={op.id} data-testid="api-operation" data-name={op.name} className="rounded-lg border border-border/50 overflow-hidden">
            {/* Operation header */}
            <button
              onClick={() => setExpandedOp(isExpanded ? null : op.id)}
              className="flex items-center gap-2 w-full px-space-4 py-space-3 hover:bg-muted/30 transition-colors"
            >
              {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
              <Badge className={`text-[11px] h-5 font-mono font-bold border ${methodColor}`}>
                {op.httpMethod}
              </Badge>
              <span className="font-mono text-body-small text-foreground">{op.httpPath}</span>
              <span className="text-caption text-muted-foreground flex-1 text-left truncate ml-2">
                {op.name}
              </span>
              <span className="text-[10px] text-muted-foreground/50">
                {op.parameters.length}p · {op.responses.length}r
              </span>
            </button>

            {/* Expanded editor */}
            {isExpanded && (
              <div className="border-t border-border/30 px-space-4 py-space-3 space-y-space-3">
                {/* Basic info */}
                <div className="grid grid-cols-2 gap-space-2">
                  <div>
                    <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider block mb-0.5">Name</label>
                    <Input value={op.name} onChange={(e) => updateOperation(op.id, { name: e.target.value })} className="h-7 font-mono text-caption" disabled={isReadOnly} />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider block mb-0.5">Description</label>
                    <Input value={op.description} onChange={(e) => updateOperation(op.id, { description: e.target.value })} className="h-7 text-caption" disabled={isReadOnly} />
                  </div>
                </div>

                {/* Parameters */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Parameters</label>
                    {!isReadOnly && (
                      <button onClick={() => addParam(op.id)} className="text-[10px] text-primary hover:underline">+ Add</button>
                    )}
                  </div>
                  {op.parameters.length === 0 && (
                    <p className="text-[11px] text-muted-foreground/40 italic">No parameters</p>
                  )}
                  {op.parameters.map((p, pi) => (
                    <div key={pi} className="flex items-center gap-1 mb-1">
                      <select value={p.location} onChange={(e) => updateParam(op.id, pi, { location: e.target.value as OperationParam["location"] })} disabled={isReadOnly} className="h-6 w-16 rounded border border-border bg-popover px-1 text-[10px]">
                        {LOCATIONS.map((l) => <option key={l} value={l}>@{l}</option>)}
                      </select>
                      <Input value={p.name} onChange={(e) => updateParam(op.id, pi, { name: e.target.value })} placeholder="name" className="h-6 w-24 font-mono text-[11px]" disabled={isReadOnly} />
                      <span className="text-[10px] text-muted-foreground">:</span>
                      <select value={p.type} onChange={(e) => updateParam(op.id, pi, { type: e.target.value })} disabled={isReadOnly} className="h-6 flex-1 rounded border border-border bg-popover px-1 text-[10px] font-mono">
                        <option value="string">string</option>
                        <option value="int32">int32</option>
                        <option value="int64">int64</option>
                        <option value="boolean">boolean</option>
                        <option value={entityName}>{entityName}</option>
                        {fields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                      </select>
                      <label className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                        <input type="checkbox" checked={p.required} onChange={(e) => updateParam(op.id, pi, { required: e.target.checked })} disabled={isReadOnly} className="accent-primary" />
                        req
                      </label>
                      {!isReadOnly && (
                        <button onClick={() => removeParam(op.id, pi)} className="text-muted-foreground hover:text-destructive">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Responses */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Responses</label>
                    {!isReadOnly && (
                      <button onClick={() => addResponse(op.id)} className="text-[10px] text-primary hover:underline">+ Add</button>
                    )}
                  </div>
                  {op.responses.map((r, ri) => (
                    <div key={ri} className="flex items-center gap-1 mb-1">
                      <select value={r.statusCode} onChange={(e) => updateResponse(op.id, ri, { statusCode: parseInt(e.target.value) })} disabled={isReadOnly} className="h-6 w-16 rounded border border-border bg-popover px-1 text-[10px] font-mono">
                        {COMMON_STATUS_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <span className="text-[10px] text-muted-foreground">→</span>
                      <Input value={r.type} onChange={(e) => updateResponse(op.id, ri, { type: e.target.value })} placeholder="ResponseType" className="h-6 flex-1 font-mono text-[11px]" disabled={isReadOnly} />
                      <Input value={r.description} onChange={(e) => updateResponse(op.id, ri, { description: e.target.value })} placeholder="description" className="h-6 flex-1 text-[11px]" disabled={isReadOnly} />
                      {!isReadOnly && (
                        <button onClick={() => removeResponse(op.id, ri)} className="text-muted-foreground hover:text-destructive">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Delete operation */}
                {!isReadOnly && (
                  <div className="flex justify-end pt-2 border-t border-border/30">
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive gap-1" onClick={() => deleteOperation(op.id)}>
                      <Trash2 className="w-3 h-3" />
                      Delete Operation
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
