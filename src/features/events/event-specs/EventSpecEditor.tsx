"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  renameEventSpecAction, updateEventSpecDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions";
import { actionErrorText } from "@/types/action-result";
import type { EventSpecDetail, EventSpecDocument } from "@/lib/events/types";
import type { EventSpecOperation, EventSpecServer } from "@/lib/event-specs/types";
import type { ChannelOption, MessageRefOption, TraitOption } from "@/features/events/load-options";

const selectClass = "w-full rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small";
type Problem = { pointer: string; message: string };

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;
}

/** Strip UI-only empties so the saved document is exactly the spec §6.1 shape. Fields the form does not show are kept as they are. */
function cleanDocument(doc: EventSpecDocument): EventSpecDocument {
  return compact({
    info: compact({ ...doc.info }),
    defaultContentType: doc.defaultContentType,
    servers: doc.servers.map((s) => compact({ ...s })),
    operations: doc.operations.map((o) => compact({ ...o })),
    components: doc.components,
  }) as EventSpecDocument;
}

/** `details.problems` of a VALIDATION_ERROR, ignoring anything that is not a `{ pointer, message }` pair. */
function readProblems(details: object | undefined): Problem[] {
  const list = (details as { problems?: unknown } | undefined)?.problems;
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is Problem => typeof p?.pointer === "string" && typeof p?.message === "string");
}

const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

export function EventSpecEditor({
  spec, productId, channelOptions, messageOptions, operationTraits, onSaved,
}: {
  spec: EventSpecDetail;
  productId: string;
  channelOptions: ChannelOption[];
  messageOptions: MessageRefOption[];
  operationTraits: TraitOption[];
  onSaved: (detail: EventSpecDetail) => void;
}) {
  const [name, setName] = useState(spec.name);
  const [doc, setDoc] = useState<EventSpecDocument>(spec.document);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const channelsById = useMemo(() => new Map(channelOptions.map((c) => [c.id, c])), [channelOptions]);
  const messageIds = useMemo(() => new Set(messageOptions.map((m) => m.id)), [messageOptions]);
  const traitIds = useMemo(() => new Set(operationTraits.map((t) => t.id)), [operationTraits]);

  const patchInfo = (patch: Partial<EventSpecDocument["info"]>) => setDoc((d) => ({ ...d, info: { ...d.info, ...patch } }));
  const patchServer = (i: number, patch: Partial<EventSpecServer>) =>
    setDoc((d) => ({ ...d, servers: d.servers.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const patchOperation = (i: number, patch: Partial<EventSpecOperation>) =>
    setDoc((d) => ({ ...d, operations: d.operations.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));

  async function save() {
    setSaving(true);
    setError(null);
    setProblems([]);
    if (name.trim() !== spec.name) {
      const renamed = await renameEventSpecAction(spec.id, productId, name);
      if (!renamed.success) {
        setSaving(false);
        return setError(actionErrorText(renamed));
      }
    }
    const r = await updateEventSpecDocumentAction(spec.id, productId, cleanDocument(doc));
    setSaving(false);
    if (!r.success) {
      setError(actionErrorText(r));
      setProblems(readProblems(r.details));
      return;
    }
    toast.success("Draft saved");
    onSaved(r.data);
  }

  return (
    <div className="space-y-space-6" data-testid="spec-editor-form">
      <div className="flex items-center justify-end">
        <Button onClick={save} disabled={saving} data-testid="spec-save" className="gap-1.5">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save draft</Button>
      </div>
      {error && (
        <div role="alert" className="text-body-small text-destructive">
          <p>{error}</p>
          {problems.length > 0 && <ul className="list-disc pl-5">{problems.map((p) => <li key={`${p.pointer}-${p.message}`}>{`${p.pointer}: ${p.message}`}</li>)}</ul>}
        </div>
      )}

      <section className="space-y-space-3">
        <h3 className="text-heading-3 text-foreground">Info</h3>
        <div className="grid grid-cols-1 gap-space-3 md:grid-cols-3">
          <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Name</span><Input aria-label="Spec name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Title (info.title)</span><Input aria-label="Title" value={doc.info.title} onChange={(e) => patchInfo({ title: e.target.value })} /></label>
          <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Default content type</span><Input aria-label="Default content type" value={doc.defaultContentType ?? ""} onChange={(e) => setDoc((d) => ({ ...d, defaultContentType: e.target.value || undefined }))} /></label>
          <label className="space-y-space-1 md:col-span-3"><span className="block text-caption text-muted-foreground">Description</span><Textarea aria-label="Description" rows={2} value={doc.info.description ?? ""} onChange={(e) => patchInfo({ description: e.target.value || undefined })} /></label>
        </div>
      </section>

      <section className="space-y-space-3">
        <div className="flex items-center justify-between">
          <h3 className="text-heading-3 text-foreground">Server references</h3>
          <Button size="sm" variant="outline" data-testid="spec-add-server" className="gap-1.5"
            onClick={() => setDoc((d) => ({ ...d, servers: [...d.servers, { key: "", protocol: "", host: "" }] }))}>
            <Plus className="w-4 h-4" /> Add server
          </Button>
        </div>
        {doc.servers.map((s, i) => (
          <div key={i} data-testid={`spec-server-${i}`} className="grid grid-cols-1 items-end gap-space-2 rounded-md border border-border/50 p-space-3 md:grid-cols-6">
            <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Key</span><Input aria-label="Key" value={s.key} onChange={(e) => patchServer(i, { key: e.target.value })} /></label>
            <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Protocol</span><Input aria-label="Protocol" value={s.protocol} onChange={(e) => patchServer(i, { protocol: e.target.value })} /></label>
            <label className="space-y-space-1 md:col-span-2"><span className="block text-caption text-muted-foreground">Host</span><Input aria-label="Host" value={s.host} onChange={(e) => patchServer(i, { host: e.target.value })} /></label>
            <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Pathname</span><Input aria-label="Pathname" value={s.pathname ?? ""} onChange={(e) => patchServer(i, { pathname: e.target.value || undefined })} /></label>
            <Button size="sm" variant="ghost" aria-label="Remove server" onClick={() => setDoc((d) => ({ ...d, servers: d.servers.filter((_, j) => j !== i) }))}><Trash2 className="w-4 h-4" /></Button>
          </div>
        ))}
      </section>

      <section className="space-y-space-3">
        <div className="flex items-center justify-between">
          <h3 className="text-heading-3 text-foreground">Operations</h3>
          <Button size="sm" variant="outline" data-testid="spec-add-operation" className="gap-1.5"
            onClick={() => setDoc((d) => ({ ...d, operations: [...d.operations, { key: "", action: "send", channelId: "", messageVersionIds: [], traitIds: [] }] }))}>
            <Plus className="w-4 h-4" /> Add operation
          </Button>
        </div>
        {doc.operations.map((op, i) => {
          const channel = channelsById.get(op.channelId);
          // A draft keeps ids of deleted messages / traits / channels: show them so they can be removed (saving would reject them).
          const removedMessages = op.messageVersionIds.filter((id) => !messageIds.has(id));
          const removedTraits = op.traitIds.filter((id) => !traitIds.has(id));
          return (
            <div key={i} data-testid={`spec-operation-${i}`} className="space-y-space-3 rounded-md border border-border/50 p-space-3">
              <div className="grid grid-cols-1 items-end gap-space-2 md:grid-cols-6">
                <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Key</span><Input aria-label="Key" value={op.key} onChange={(e) => patchOperation(i, { key: e.target.value })} /></label>
                <label className="space-y-space-1">
                  <span className="block text-caption text-muted-foreground">Action</span>
                  <select aria-label="Action" className={selectClass} value={op.action} onChange={(e) => patchOperation(i, { action: e.target.value as EventSpecOperation["action"] })}>
                    <option value="send">send</option>
                    <option value="receive">receive</option>
                  </select>
                </label>
                <label className="space-y-space-1 md:col-span-3">
                  <span className="block text-caption text-muted-foreground">Channel</span>
                  <select aria-label="Channel" className={selectClass} value={op.channelId} onChange={(e) => patchOperation(i, { channelId: e.target.value })}>
                    <option value="">Select a channel</option>
                    {op.channelId && !channel && <option value={op.channelId}>{`Unavailable channel (${op.channelId})`}</option>}
                    {["This product", "Other products (read-only)"].map((group) => {
                      const inGroup = channelOptions.filter((c) => c.own === (group === "This product"));
                      return inGroup.length === 0 ? null : (
                        <optgroup key={group} label={group}>
                          {inGroup.map((c) => (
                            <option key={c.id} value={c.id}>{`${c.name} — ${c.address ?? "(no address)"} (${c.protocol}/${c.format})${c.own ? "" : ` · ${c.ownerLabel}`}`}</option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </label>
                <Button size="sm" variant="ghost" aria-label="Remove operation" onClick={() => setDoc((d) => ({ ...d, operations: d.operations.filter((_, j) => j !== i) }))}><Trash2 className="w-4 h-4" /></Button>
              </div>
              <label className="block space-y-space-1"><span className="block text-caption text-muted-foreground">Summary</span><Input aria-label="Summary" value={op.summary ?? ""} onChange={(e) => patchOperation(i, { summary: e.target.value || undefined })} /></label>
              <fieldset className="space-y-space-1">
                <legend className="text-caption text-muted-foreground">Messages (pinned versions; drafts are preview only)</legend>
                <div className="grid grid-cols-1 gap-space-1 md:grid-cols-2">
                  {messageOptions.map((m) => (
                    <label key={m.id} className="flex items-center gap-space-2 text-body-small">
                      <input type="checkbox" aria-label={m.label} checked={op.messageVersionIds.includes(m.id)}
                        onChange={() => patchOperation(i, { messageVersionIds: toggleIn(op.messageVersionIds, m.id) })} />
                      {m.label}
                      <span className="text-caption text-muted-foreground">{m.ownerLabel}</span>
                      {channel?.allowedMessageIds.includes(m.messageId) && <Badge variant="outline">allowed on channel</Badge>}
                    </label>
                  ))}
                  {removedMessages.map((id) => (
                    <label key={id} className="flex items-center gap-space-2 text-body-small text-destructive">
                      <input type="checkbox" aria-label={`Unavailable message (${id})`} checked onChange={() => patchOperation(i, { messageVersionIds: toggleIn(op.messageVersionIds, id) })} />
                      {`Unavailable message (${id})`}
                    </label>
                  ))}
                </div>
              </fieldset>
              {(operationTraits.length > 0 || removedTraits.length > 0) && (
                <fieldset className="flex flex-wrap gap-space-4">
                  <legend className="text-caption text-muted-foreground">Operation traits</legend>
                  {operationTraits.map((t) => (
                    <label key={t.id} className="flex items-center gap-space-2 text-body-small">
                      <input type="checkbox" aria-label={t.name} checked={op.traitIds.includes(t.id)} onChange={() => patchOperation(i, { traitIds: toggleIn(op.traitIds, t.id) })} />
                      {t.name}
                    </label>
                  ))}
                  {removedTraits.map((id) => (
                    <label key={id} className="flex items-center gap-space-2 text-body-small text-destructive">
                      <input type="checkbox" aria-label={`Unavailable trait (${id})`} checked onChange={() => patchOperation(i, { traitIds: toggleIn(op.traitIds, id) })} />
                      {`Unavailable trait (${id})`}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
