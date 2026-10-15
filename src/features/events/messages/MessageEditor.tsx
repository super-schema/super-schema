"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deleteMessageAction, updateMessageAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { formatJsonText, parseJsonObjectArrayText, parseJsonObjectText } from "@/lib/events/inputs";
import { GENERIC_ACTION_ERROR, isOpaqueErrorCode } from "@/types/action-result";
import type { EntityPin, MessageDetail, MessageSpec } from "@/lib/events/types";
import type { TraitOption } from "@/features/events/load-options";
import { EntityPinPicker, type EntityOption } from "@/features/events/shared/EntityPinPicker";
import { JsonField } from "@/features/events/shared/JsonField";

interface Failure {
  message: string;
  problems: string[];
  suggestedFix?: string;
}

function toFailure(r: { error: string; code?: string; details?: object; suggestedFix?: string }): Failure {
  if (isOpaqueErrorCode(r.code)) return { message: GENERIC_ACTION_ERROR, problems: [] };
  const list = (r.details as { problems?: unknown } | undefined)?.problems;
  return { message: r.error, problems: Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [], suggestedFix: r.suggestedFix };
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** An all-whitespace text field is cleared; anything else is sent exactly as loaded or typed. */
const textOrUndefined = (value: string) => (value.trim() === "" ? undefined : value);

export function MessageEditor({
  message, productId, listHref, entityOptions, traitOptions,
}: {
  message: MessageDetail;
  productId: string;
  listHref: string;
  entityOptions: EntityOption[];
  traitOptions: TraitOption[];
}) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const s = message.spec;
  const initialCorrelation = typeof s.correlationId?.location === "string" ? s.correlationId.location : "";
  const [name, setName] = useState(message.name);
  const [title, setTitle] = useState(s.title ?? "");
  const [summary, setSummary] = useState(s.summary ?? "");
  const [description, setDescription] = useState(s.description ?? "");
  const [contentType, setContentType] = useState(s.contentType ?? "");
  const [correlation, setCorrelation] = useState(initialCorrelation);
  const [payload, setPayload] = useState<EntityPin | null>(message.payload);
  const [headers, setHeaders] = useState<EntityPin | null>(message.headers);
  const [keyPin, setKeyPin] = useState<EntityPin | null>(message.key);
  const [traitIds, setTraitIds] = useState<string[]>(s.traitIds);
  const [bindingsText, setBindingsText] = useState(formatJsonText(s.bindings));
  const [examplesText, setExamplesText] = useState(formatJsonText(s.examples));
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const fail = (text: string) => setFailure({ message: text, problems: [] });

  /**
   * `updateMessage` is a FULL REPLACE: what is sent here is the whole draft. Pins go back exactly as loaded (`entityVersionId`
   * null = explicitly unpinned; omitting it would re-pin the entity's latest version), and every spec field the form does not
   * edit — or the user did not touch — is carried over unchanged.
   */
  async function save() {
    const bindings = parseJsonObjectText(bindingsText, "Bindings");
    const examples = parseJsonObjectArrayText(examplesText, "Examples");
    if (!bindings.success) return fail(bindings.error.message);
    if (!examples.success) return fail(examples.error.message);
    if (!payload) return fail("A payload entity is required");
    setBusy("save");
    setFailure(null);
    const spec: MessageSpec = compact({
      ...s,
      title: textOrUndefined(title),
      summary: textOrUndefined(summary),
      description: textOrUndefined(description),
      contentType: textOrUndefined(contentType),
      // Untouched → keep the stored object as is, even one without a location; edited → only `location` changes.
      correlationId: correlation === initialCorrelation ? s.correlationId : correlation.trim() ? { ...s.correlationId, location: correlation.trim() } : undefined,
      bindings: bindings.data,
      examples: examples.data,
      traitIds,
    });
    try {
      const r = await updateMessageAction(message.id, productId, { name, spec, payload, headers, key: keyPin });
      if (!r.success) return setFailure(toFailure(r));
      toast.success("Message saved");
      router.refresh();
    } catch {
      setFailure({ message: GENERIC_ACTION_ERROR, problems: [] });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete message "${message.name}"?`)) return;
    setBusy("delete");
    setFailure(null);
    try {
      const r = await deleteMessageAction(message.id, productId);
      if (!r.success) return setFailure(toFailure(r));
      void invalidateDomainsTree(); // the explorer reads a cached tree: without this the deleted row stays until a reload
      router.push(listHref);
    } catch {
      setFailure({ message: GENERIC_ACTION_ERROR, problems: [] });
    } finally {
      setBusy(null);
    }
  }

  const toggleTrait = (id: string) => setTraitIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  // A stored trait the product can no longer see has no checkbox in `traitOptions`; without one here it could never be removed.
  const visibleTraitIds = new Set(traitOptions.map((t) => t.id));
  const unavailableTraitIds = traitIds.filter((id) => !visibleTraitIds.has(id));
  const text = (label: string, value: string, onChange: (v: string) => void, placeholder?: string) => (
    <label className="space-y-space-1">
      <span className="block text-caption text-muted-foreground">{label}</span>
      <Input aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );

  return (
    <div className="space-y-space-6" data-testid="message-editor-form">
      <div className="flex justify-end gap-space-2">
        <Button variant="outline" onClick={remove} disabled={busy !== null} data-testid="message-delete" className="gap-1.5 text-muted-foreground hover:text-destructive">
          {busy === "delete" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Delete
        </Button>
        <Button onClick={save} disabled={busy !== null} data-testid="message-save" className="gap-1.5">
          {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save draft
        </Button>
      </div>
      {failure && (
        <div role="alert" className="space-y-space-1 text-body-small text-destructive" data-testid="message-error">
          {failure.problems.length > 0 ? (
            <>
              <p>The message was not saved:</p>
              <ul className="list-disc pl-5">{failure.problems.map((p, i) => <li key={`${i}-${p}`}>{p}</li>)}</ul>
            </>
          ) : (
            <p>{failure.message}</p>
          )}
          {failure.suggestedFix && <p className="text-muted-foreground">{failure.suggestedFix}</p>}
        </div>
      )}

      <section className="grid grid-cols-1 gap-space-4 md:grid-cols-2">
        {text("Name", name, setName)}
        {text("Title", title, setTitle)}
        {text("Summary", summary, setSummary)}
        {text("Content type", contentType, setContentType, "defaults from the channel format (avro/binary, application/json, …)")}
        {text("Correlation ID location", correlation, setCorrelation, "$message.header#/ce_id")}
        <label className="space-y-space-1 md:col-span-2">
          <span className="block text-caption text-muted-foreground">Description</span>
          <Textarea aria-label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </section>

      <section className="grid grid-cols-1 gap-space-4 md:grid-cols-3">
        <EntityPinPicker id="payload" label="Payload" entities={entityOptions} value={payload} onChange={setPayload} />
        <EntityPinPicker id="headers" label="Headers" optional entities={entityOptions} value={headers} onChange={setHeaders} hint="Rendered as a JSON Schema object." />
        <EntityPinPicker id="key" label="Kafka key" optional entities={entityOptions} value={keyPin} onChange={setKeyPin} hint="Emitted only on Kafka channels (Avro on Avro channels, else JSON Schema)." />
      </section>

      <section className="space-y-space-2">
        <h3 className="text-heading-3 text-foreground">Traits</h3>
        {traitOptions.length === 0 && unavailableTraitIds.length === 0 && (
          <p className="text-caption text-muted-foreground">No message traits visible from this product.</p>
        )}
        <div className="flex flex-wrap gap-space-4">
          {traitOptions.map((t) => (
            <label key={t.id} className="flex items-center gap-space-2 text-body-small">
              <input type="checkbox" aria-label={t.name} checked={traitIds.includes(t.id)} onChange={() => toggleTrait(t.id)} />
              {t.name} <span className="text-caption text-muted-foreground">{t.ownerLabel}</span>
            </label>
          ))}
          {unavailableTraitIds.map((id) => (
            <label key={id} className="flex items-center gap-space-2 text-body-small">
              <input type="checkbox" aria-label={`Unavailable trait ${id}`} checked onChange={() => toggleTrait(id)} />
              Unavailable trait <span className="font-mono text-caption text-muted-foreground">{id}</span>
              <span className="text-caption text-muted-foreground">— not visible from this product; clear it to remove</span>
            </label>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-space-4 md:grid-cols-2">
        <JsonField id="message-bindings" label="Bindings" mode="object" value={bindingsText} onChange={setBindingsText} placeholder='{ "kafka": { "schemaIdLocation": "header" } }' />
        <JsonField id="message-examples" label="Examples" mode="array" value={examplesText} onChange={setExamplesText} placeholder='[{ "payload": { } }]' />
      </section>
    </div>
  );
}
