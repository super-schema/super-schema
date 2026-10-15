"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Radio, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteChannelAction, setChannelMessagesAction, updateChannelAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions";
import { noticeFor, settleAction, type ActionNotice } from "@/lib/action-error";
import { formatJsonText, JSON_SCHEMA_DIALECTS, KNOWN_PROTOCOLS, parseJsonObjectText, PAYLOAD_FORMATS } from "@/lib/events/inputs";
import type { ChannelSpec, JsonObject } from "@/lib/events/types";
import { ActionNoticeAlert } from "@/features/events/shared/ActionNoticeAlert";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import { JsonField } from "@/features/events/shared/JsonField";
import type { ChannelPageData } from "./load-channel-page";

const selectClass = "w-full rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small";
const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;
}

export function ChannelEditor({ channel, productId, crumbs, listHref, messageOptions }: ChannelPageData) {
  const router = useRouter();
  const [name, setName] = useState(channel.name);
  const [address, setAddress] = useState(channel.address ?? "");
  const [protocol, setProtocol] = useState(channel.protocol);
  const [format, setFormat] = useState<string>(channel.format);
  const [dialect, setDialect] = useState<string>(channel.formatDialect ?? "draft-07");
  const [title, setTitle] = useState(channel.spec.title ?? "");
  const [summary, setSummary] = useState(channel.spec.summary ?? "");
  const [description, setDescription] = useState(channel.spec.description ?? "");
  const [parametersText, setParametersText] = useState(formatJsonText(channel.spec.parameters));
  const [bindingsText, setBindingsText] = useState(formatJsonText(channel.spec.bindings));
  const [allowed, setAllowed] = useState<string[]>(channel.allowedMessageIds);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);

  async function save() {
    const parameters = parseJsonObjectText(parametersText, "Parameters");
    const bindings = parseJsonObjectText(bindingsText, "Bindings");
    if (!parameters.success) return setNotice({ message: parameters.error.message });
    if (!bindings.success) return setNotice({ message: bindings.error.message });
    setBusy(true);
    setNotice(null);
    try {
      // `updateChannel` is a full replace of the editable columns: send every one, including the spec fields this form has no input for.
      const spec: ChannelSpec = compact({
        title, summary, description,
        parameters: parameters.data as Record<string, JsonObject> | undefined,
        bindings: bindings.data,
        tags: channel.spec.tags,
        externalDocs: channel.spec.externalDocs,
      });
      const saved = await settleAction(() =>
        updateChannelAction(channel.id, productId, {
          name, address: address.trim() || null, protocol, format, formatDialect: format === "json-schema" ? dialect : null, spec,
        })
      );
      if (!saved.success) return setNotice(noticeFor(saved));
      if (!sameIds(allowed, channel.allowedMessageIds)) {
        const messages = await settleAction(() => setChannelMessagesAction(channel.id, productId, allowed));
        if (!messages.success) {
          // The channel itself is already saved: refresh so the page reflects it, and say which half failed.
          router.refresh();
          const failure = noticeFor(messages);
          return setNotice({ ...failure, message: `Channel saved, but the allowed messages were not updated: ${failure.message}` });
        }
      }
      toast.success("Channel saved");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete channel "${channel.name}"? Draft event specs that use it will report it as unresolved.`)) return;
    setBusy(true);
    setNotice(null);
    const deleted = await settleAction(() => deleteChannelAction(channel.id, productId));
    if (!deleted.success) {
      setBusy(false);
      return setNotice(noticeFor(deleted));
    }
    router.push(listHref); // stays busy: the page is going away, and a second click would only report "not found"
  }

  const toggle = (id: string) => setAllowed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <EventBreadcrumb crumbs={crumbs} />
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-space-2 text-display text-foreground"><Radio className="w-6 h-6" /> {channel.name}</h1>
        <div className="flex gap-space-2">
          <Button variant="outline" onClick={remove} disabled={busy} data-testid="channel-delete" className="gap-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /> Delete</Button>
          <Button onClick={save} disabled={busy} data-testid="channel-save" className="gap-1.5">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save</Button>
        </div>
      </div>
      <ActionNoticeAlert notice={notice} testId="channel-error" />

      <section className="grid grid-cols-1 gap-space-4 md:grid-cols-2">
        <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Name</span><Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Address (topic / queue; {"{param}"} allowed)</span><Input aria-label="Address" value={address} onChange={(e) => setAddress(e.target.value)} /></label>
        <label className="space-y-space-1">
          <span className="block text-caption text-muted-foreground">Protocol</span>
          <Input aria-label="Protocol" list="channel-protocols" value={protocol} onChange={(e) => setProtocol(e.target.value)} />
          <datalist id="channel-protocols">{KNOWN_PROTOCOLS.map((p) => <option key={p} value={p} />)}</datalist>
        </label>
        <div className="grid grid-cols-2 gap-space-2">
          <label className="space-y-space-1">
            <span className="block text-caption text-muted-foreground">Format profile</span>
            <select aria-label="Format" className={selectClass} value={format} onChange={(e) => setFormat(e.target.value)}>
              {PAYLOAD_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          {format === "json-schema" && (
            <label className="space-y-space-1">
              <span className="block text-caption text-muted-foreground">Dialect</span>
              <select aria-label="Dialect" className={selectClass} value={dialect} onChange={(e) => setDialect(e.target.value)}>
                {JSON_SCHEMA_DIALECTS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
        </div>
        <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Title</span><Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="space-y-space-1"><span className="block text-caption text-muted-foreground">Summary</span><Input aria-label="Summary" value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        <label className="space-y-space-1 md:col-span-2"><span className="block text-caption text-muted-foreground">Description</span><Textarea aria-label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <JsonField id="channel-parameters" label="Parameters" mode="object" value={parametersText} onChange={setParametersText} placeholder='{ "region": { "description": "…" } }' />
        <JsonField id="channel-bindings" label="Bindings" mode="object" value={bindingsText} onChange={setBindingsText} placeholder='{ "kafka": { "partitions": 12 } }' />
      </section>

      <section className="space-y-space-2">
        <h2 className="text-heading-2 text-foreground">Allowed messages</h2>
        <p className="text-caption text-muted-foreground">Messages that may travel on this channel (any product). Event specs pin versions per operation.</p>
        <div className="grid grid-cols-1 gap-space-1 md:grid-cols-2">
          {messageOptions.map((m) => (
            <label key={m.id} className="flex items-center gap-space-2 text-body-small">
              <input type="checkbox" aria-label={m.name} checked={allowed.includes(m.id)} onChange={() => toggle(m.id)} />
              {m.name} <span className="text-caption text-muted-foreground">{m.ownerLabel}</span>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
