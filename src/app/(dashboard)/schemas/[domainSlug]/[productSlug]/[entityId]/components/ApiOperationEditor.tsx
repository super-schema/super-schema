"use client";

import { memo, useId } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AttributesSection } from "@/components/custom/metadata/AttributesSection";
import { HTTP_METHODS, PARAM_LOCATIONS, type ApiOperationRecord, type ApiParameter, type ApiRequestBody } from "@/types/schemas/api-operation";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import type { ApiOperationIssue } from "@/lib/api-operations/validate";
import {
  COMMON_CONTENT_TYPES,
  HTTP_STATUS_CODES,
  isPlacedIssuePath,
  issuesByPath,
  nextStatusCode,
  syncPathParameters,
  type OperationDraft,
  type TypeOptionGroups,
} from "./api-tab-model";
import { FieldError, FieldLabel, LABEL, TagInput, TypePicker } from "./ApiFormControls";

import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
export const METHOD_COLORS: Record<string, string> = {
  GET: "bg-green-500/15 text-green-600 border-green-500/30",
  POST: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  PUT: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  DELETE: "bg-red-500/15 text-red-600 border-red-500/30",
  PATCH: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  HEAD: "bg-slate-500/15 text-slate-600 border-slate-500/30",
  OPTIONS: "bg-slate-500/15 text-slate-600 border-slate-500/30",
};

const INPUT = "h-7 text-caption";
const NO_WARNINGS: readonly string[] = [];
const NO_DEFINITIONS: readonly MetadataAttributeDefinition[] = [];
const CONTENT_TYPE_LIST = "api-content-types";

interface ApiOperationRowProps {
  draft: OperationDraft;
  index: number;
  count: number;
  expanded: boolean;
  /** Client + server issues of this draft (server `issues[]` use the same paths). */
  issues: ApiOperationIssue[];
  /** Save-time warnings (stored, but not generated as written): shown, never blocking. */
  warnings?: readonly string[];
  groups: TypeOptionGroups;
  readOnly: boolean;
  /** The tenant's metadata attribute dictionary (the "Metadata" section offers its operation-target attributes). */
  definitions?: readonly MetadataAttributeDefinition[];
  onToggle: (id: string) => void;
  onChange: (next: OperationDraft) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}

/** One operation: its summary row (expand toggle, reorder) and, expanded, its editor. */
export const ApiOperationRow = memo(function ApiOperationRow({
  draft, index, count, expanded, issues, warnings = NO_WARNINGS, groups, readOnly, definitions = NO_DEFINITIONS, onToggle, onChange, onDelete, onDuplicate, onMove,
}: ApiOperationRowProps) {
  const methodColor = METHOD_COLORS[draft.httpMethod] ?? METHOD_COLORS.GET;
  const hasIssues = issues.length > 0;
  return (
    <div
      data-testid="api-operation"
      data-name={draft.name}
      data-operation-id={draft.id}
      data-invalid={hasIssues || undefined}
      className={cn("rounded-lg border overflow-hidden", hasIssues ? "border-destructive/40" : "border-border/50")}
    >
      <div className="flex items-center hover:bg-muted/30 transition-colors">
        <button
          type="button"
          onClick={() => onToggle(draft.id)}
          aria-expanded={expanded}
          className="flex items-center gap-2 flex-1 min-w-0 px-space-4 py-space-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
          <Badge className={`text-[11px] h-5 font-mono font-bold border ${methodColor}`}>{draft.httpMethod}</Badge>
          <span className={cn("font-mono text-body-small text-foreground", draft.deprecated && "line-through text-muted-foreground")}>{draft.httpPath}</span>
          <span className="text-caption text-muted-foreground flex-1 text-left truncate ml-2">{draft.name}</span>
          {draft.deprecated && <Badge variant="outline" className="text-[9px] h-4">deprecated</Badge>}
          {draft.tags.slice(0, 3).map((t) => (
            <Badge key={t} variant="outline" className="text-[9px] h-4 font-normal">{t}</Badge>
          ))}
          {hasIssues && <span className="text-[10px] text-destructive">{issues.length} issue{issues.length === 1 ? "" : "s"}</span>}
          {!hasIssues && warnings.length > 0 && (
            <span data-testid="api-op-warning-badge" className="text-[10px] text-warning" title={warnings.join("\n")}>
              {warnings.length} warning{warnings.length === 1 ? "" : "s"}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/50 whitespace-nowrap">
            {draft.parameters.length}p · {draft.responses.length}r{draft.requestBody ? " · body" : ""}
          </span>
        </button>
        {!readOnly && count > 1 && (
          <div className="flex items-center pr-2">
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${draft.name} up`} disabled={index === 0} onClick={() => onMove(draft.id, -1)}>
              <ArrowUp />
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${draft.name} down`} disabled={index === count - 1} onClick={() => onMove(draft.id, 1)}>
              <ArrowDown />
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <OperationEditor draft={draft} issues={issues} warnings={warnings} groups={groups} readOnly={readOnly} definitions={definitions} onChange={onChange} onDelete={onDelete} onDuplicate={onDuplicate} />
      )}
    </div>
  );
});

interface OperationEditorProps {
  draft: OperationDraft;
  issues: ApiOperationIssue[];
  warnings: readonly string[];
  groups: TypeOptionGroups;
  readOnly: boolean;
  definitions: readonly MetadataAttributeDefinition[];
  onChange: (next: OperationDraft) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}

function OperationEditor({ draft, issues, warnings, groups, readOnly, definitions, onChange, onDelete, onDuplicate }: OperationEditorProps) {
  const uid = useId();
  const errors = issuesByPath(issues);
  const general = issues.filter((i) => !isPlacedIssuePath(i.path));
  const err = (path: string) => errors[path];
  const invalid = (path: string) => (errors[path] ? true : undefined);
  const id = (k: string) => `${uid}-${k}`;

  const set = (patch: Partial<OperationDraft>) => onChange({ ...draft, ...patch });
  const setPath = (httpPath: string) => set({ httpPath, parameters: syncPathParameters(draft.parameters, draft.httpPath, httpPath) });
  const setParam = (i: number, patch: Partial<ApiParameter>) =>
    set({
      parameters: draft.parameters.map((p, pi) => {
        if (pi !== i) return p;
        const next = { ...p, ...patch };
        return next.location === "path" ? { ...next, required: true } : next;
      }),
    });
  const setResponse = (i: number, patch: Partial<OperationDraft["responses"][number]>) =>
    set({ responses: draft.responses.map((r, ri) => (ri === i ? { ...r, ...patch } : r)) });
  const setBody = (patch: Partial<ApiRequestBody>) => draft.requestBody && set({ requestBody: { ...draft.requestBody, ...patch } });

  return (
    <div className="border-t border-border/30 px-space-4 py-space-3 space-y-space-4" data-testid="api-operation-editor">
      <datalist id={`${uid}-${CONTENT_TYPE_LIST}`}>
        {COMMON_CONTENT_TYPES.map((c) => <option key={c} value={c} />)}
      </datalist>

      {general.length > 0 && (
        <ul role="alert" data-testid="api-op-issues" className="rounded-md border border-destructive/30 bg-destructive/5 px-space-3 py-space-2 text-[11px] text-destructive space-y-0.5">
          {general.map((i, n) => <li key={n}>{i.path ? `${i.path}: ` : ""}{i.message}</li>)}
        </ul>
      )}

      {warnings.length > 0 && (
        <ul role="status" data-testid="api-op-warnings" className="rounded-md border border-warning/30 bg-warning/5 px-space-3 py-space-2 text-[11px] text-warning space-y-0.5">
          {warnings.map((w, n) => <li key={n}>{w}</li>)}
        </ul>
      )}

      {/* Identity */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-space-2">
        <div>
          <FieldLabel htmlFor={id("name")}>Name</FieldLabel>
          <Input id={id("name")} data-testid="api-edit-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} aria-invalid={invalid("name")} className={cn(INPUT, "font-mono")} disabled={readOnly} />
          <FieldError message={err("name")} />
        </div>
        <div>
          <FieldLabel htmlFor={id("opid")}>Operation ID</FieldLabel>
          <Input id={id("opid")} data-testid="api-edit-operation-id" value={draft.operationId ?? ""} placeholder={draft.name} onChange={(e) => set({ operationId: e.target.value })} aria-invalid={invalid("operationId")} className={cn(INPUT, "font-mono")} disabled={readOnly} />
          <FieldError message={err("operationId")} />
        </div>
        <div>
          <FieldLabel htmlFor={id("method")}>Method</FieldLabel>
          <NativeSelect id={id("method")} data-testid="api-edit-method" value={draft.httpMethod} onChange={(e) => set({ httpMethod: e.target.value as OperationDraft["httpMethod"] })} aria-invalid={invalid("httpMethod")} className="h-7 text-caption" disabled={readOnly}>
            {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </NativeSelect>
          <FieldError message={err("httpMethod")} />
        </div>
        <div>
          <FieldLabel htmlFor={id("path")}>Path</FieldLabel>
          <Input id={id("path")} data-testid="api-edit-path" value={draft.httpPath} onChange={(e) => setPath(e.target.value)} aria-invalid={invalid("httpPath")} className={cn(INPUT, "font-mono")} disabled={readOnly} />
          <FieldError message={err("httpPath")} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-space-2">
        <div>
          <FieldLabel htmlFor={id("summary")}>Summary</FieldLabel>
          <Input id={id("summary")} data-testid="api-edit-summary" value={draft.summary} onChange={(e) => set({ summary: e.target.value })} aria-invalid={invalid("summary")} className={INPUT} disabled={readOnly} />
          <FieldError message={err("summary")} />
        </div>
        <div>
          <FieldLabel htmlFor={id("desc")}>Description</FieldLabel>
          <Input id={id("desc")} data-testid="api-edit-description" value={draft.description} onChange={(e) => set({ description: e.target.value })} aria-invalid={invalid("description")} className={INPUT} disabled={readOnly} />
          <FieldError message={err("description")} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-space-2 items-end">
        <div>
          <FieldLabel htmlFor={id("tags")}>Tags</FieldLabel>
          <TagInput id={id("tags")} tags={draft.tags} onChange={(tags) => set({ tags })} disabled={readOnly} invalid={!!err("tags")} />
          <FieldError message={err("tags") ?? Object.entries(errors).find(([k]) => k.startsWith("tags."))?.[1]} />
        </div>
        <label className="flex items-center gap-1.5 text-caption text-muted-foreground h-7">
          <Checkbox data-testid="api-edit-deprecated" checked={draft.deprecated} onChange={(e) => set({ deprecated: e.target.checked })} disabled={readOnly} />
          Deprecated
        </label>
      </div>

      <AttributesSection
        target="operation" definitions={definitions} extensions={draft.extensions} readOnly={readOnly}
        onChange={(next) => set({ extensions: (next ?? {}) as ApiOperationRecord["extensions"] })}
      />

      {/* Parameters */}
      <section aria-label="Parameters">
        <div className="flex items-center justify-between mb-1">
          <span className={LABEL}>Parameters</span>
          {!readOnly && (
            <Button type="button" variant="link" size="xs" data-testid="api-add-param" onClick={() => set({ parameters: [...draft.parameters, { name: "", type: "string", isArray: false, location: "query", required: false, description: "" }] })}>
              + Add parameter
            </Button>
          )}
        </div>
        <FieldError message={err("parameters")} />
        {draft.parameters.length === 0 && <p className="text-[11px] text-muted-foreground/40 italic">No parameters</p>}
        <div className="space-y-1">
          {draft.parameters.map((p, i) => (
            <div key={i} data-testid="api-param" data-name={p.name} data-location={p.location} className="grid grid-cols-[5.5rem_minmax(6rem,1fr)_minmax(8rem,1.4fr)_auto_minmax(6rem,1fr)_auto] gap-1 items-start">
              <NativeSelect aria-label="Parameter location" value={p.location} onChange={(e) => setParam(i, { location: e.target.value as ApiParameter["location"] })} disabled={readOnly} aria-invalid={invalid(`parameters.${i}.location`)} className="h-7 text-caption font-mono">
                {PARAM_LOCATIONS.map((l) => <option key={l} value={l}>@{l}</option>)}
              </NativeSelect>
              <div>
                <Input aria-label="Parameter name" value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} placeholder="name" aria-invalid={invalid(`parameters.${i}.name`)} className={cn(INPUT, "font-mono")} disabled={readOnly} />
                <FieldError message={err(`parameters.${i}.name`)} />
              </div>
              <div>
                <TypePicker label="Parameter type" value={p.type} isArray={p.isArray} groups={groups} disabled={readOnly} invalid={!!err(`parameters.${i}.type`)} onChange={({ type, isArray }) => setParam(i, { type: type ?? "string", isArray })} />
                <FieldError message={err(`parameters.${i}.type`)} />
              </div>
              <label className="flex items-center gap-0.5 h-7 text-[10px] text-muted-foreground" title={p.location === "path" ? "Path parameters are always required" : undefined}>
                <Checkbox aria-label="Parameter required" checked={p.location === "path" ? true : p.required} onChange={(e) => setParam(i, { required: e.target.checked })} disabled={readOnly || p.location === "path"} />
                req
              </label>
              <Input aria-label="Parameter description" value={p.description} onChange={(e) => setParam(i, { description: e.target.value })} placeholder="description" className={INPUT} disabled={readOnly} />
              {!readOnly ? (
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove parameter ${p.name || i + 1}`} onClick={() => set({ parameters: draft.parameters.filter((_, pi) => pi !== i) })} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="w-3 h-3" />
                </Button>
              ) : <span />}
            </div>
          ))}
        </div>
      </section>

      {/* Request body */}
      <section aria-label="Request body">
        <div className="flex items-center justify-between mb-1">
          <span className={LABEL}>Request body</span>
          {!readOnly && (
            draft.requestBody ? (
              <Button type="button" variant="ghost" size="xs" data-testid="api-remove-body" onClick={() => set({ requestBody: null })} className="text-muted-foreground hover:text-destructive">Remove body</Button>
            ) : (
              <Button type="button" variant="link" size="xs" data-testid="api-add-body" onClick={() => set({ requestBody: { type: groups.entity, isArray: false, contentType: "application/json", required: true, description: "" } })}>
                + Add request body
              </Button>
            )
          )}
        </div>
        {!draft.requestBody ? (
          <p className="text-[11px] text-muted-foreground/40 italic">No request body</p>
        ) : (
          <div data-testid="api-body" className="grid grid-cols-[minmax(8rem,1fr)_minmax(8rem,1.4fr)_auto_minmax(6rem,1fr)] gap-1 items-start">
            <div>
              <Input aria-label="Request content type" list={`${uid}-${CONTENT_TYPE_LIST}`} value={draft.requestBody.contentType} onChange={(e) => setBody({ contentType: e.target.value })} aria-invalid={invalid("requestBody.contentType")} className={cn(INPUT, "font-mono")} disabled={readOnly} />
              <FieldError message={err("requestBody.contentType")} />
            </div>
            <div>
              <TypePicker label="Request body type" testId="api-body-type" value={draft.requestBody.type} isArray={draft.requestBody.isArray} groups={groups} disabled={readOnly} invalid={!!err("requestBody.type")} onChange={({ type, isArray }) => setBody({ type: type ?? groups.entity, isArray })} />
              <FieldError message={err("requestBody.type")} />
            </div>
            <label className="flex items-center gap-0.5 h-7 text-[10px] text-muted-foreground">
              <Checkbox aria-label="Request body required" checked={draft.requestBody.required} onChange={(e) => setBody({ required: e.target.checked })} disabled={readOnly} />
              req
            </label>
            <Input aria-label="Request body description" value={draft.requestBody.description} onChange={(e) => setBody({ description: e.target.value })} placeholder="description" className={INPUT} disabled={readOnly} />
          </div>
        )}
        <FieldError message={err("requestBody")} />
      </section>

      {/* Responses */}
      <section aria-label="Responses">
        <div className="flex items-center justify-between mb-1">
          <span className={LABEL}>Responses</span>
          {!readOnly && (
            <Button type="button" variant="link" size="xs" data-testid="api-add-response" onClick={() => set({ responses: [...draft.responses, { statusCode: nextStatusCode(draft.responses.map((r) => r.statusCode)), type: null, isArray: false, contentType: "application/json", description: "" }] })}>
              + Add response
            </Button>
          )}
        </div>
        <FieldError message={err("responses")} />
        {draft.responses.length === 0 && <p className="text-[11px] text-muted-foreground/40 italic">No responses</p>}
        <div className="space-y-1">
          {draft.responses.map((r, i) => (
            <div key={i} data-testid="api-response" data-status={r.statusCode} className="grid grid-cols-[minmax(7rem,0.9fr)_minmax(8rem,1.3fr)_minmax(8rem,1fr)_minmax(6rem,1fr)_auto] gap-1 items-start">
              <div>
                <NativeSelect aria-label="Response status" value={r.statusCode} onChange={(e) => setResponse(i, { statusCode: Number(e.target.value) })} disabled={readOnly} aria-invalid={invalid(`responses.${i}.statusCode`)} className="h-7 text-caption font-mono">
                  {!HTTP_STATUS_CODES.some((s) => s.code === r.statusCode) && <option value={r.statusCode}>{r.statusCode}</option>}
                  {HTTP_STATUS_CODES.map((s) => <option key={s.code} value={s.code}>{s.code} {s.label}</option>)}
                </NativeSelect>
                <FieldError message={err(`responses.${i}.statusCode`)} />
              </div>
              <div>
                <TypePicker label="Response type" allowNone value={r.type} isArray={r.isArray} groups={groups} disabled={readOnly} invalid={!!err(`responses.${i}.type`)} onChange={({ type, isArray }) => setResponse(i, { type, isArray })} />
                <FieldError message={err(`responses.${i}.type`)} />
              </div>
              <div>
                <Input aria-label="Response content type" list={`${uid}-${CONTENT_TYPE_LIST}`} value={r.contentType} onChange={(e) => setResponse(i, { contentType: e.target.value })} aria-invalid={invalid(`responses.${i}.contentType`)} className={cn(INPUT, "font-mono")} disabled={readOnly || !r.type} />
                <FieldError message={err(`responses.${i}.contentType`)} />
              </div>
              <Input aria-label="Response description" value={r.description} onChange={(e) => setResponse(i, { description: e.target.value })} placeholder="description" className={INPUT} disabled={readOnly} />
              {!readOnly ? (
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove response ${r.statusCode}`} onClick={() => set({ responses: draft.responses.filter((_, ri) => ri !== i) })} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="w-3 h-3" />
                </Button>
              ) : <span />}
            </div>
          ))}
        </div>
      </section>

      {!readOnly && (
        <div className="flex justify-end gap-2 pt-2 border-t border-border/30">
          <Button type="button" variant="ghost" size="sm" className="gap-1" data-testid="api-op-duplicate" onClick={() => onDuplicate(draft.id)}>
            <Copy className="w-3 h-3" />
            Duplicate
          </Button>
          <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive gap-1" onClick={() => onDelete(draft.id)}>
            <Trash2 className="w-3 h-3" />
            Delete Operation
          </Button>
        </div>
      )}
    </div>
  );
}
