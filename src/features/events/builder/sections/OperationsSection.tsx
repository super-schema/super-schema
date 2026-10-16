"use client";

// src/features/events/builder/sections/OperationsSection.tsx
// Operations: send/receive, the channel, the messages (limited to that channel's messages) and an optional reply, drawn by hand
// because they can only offer valid combinations; everything else the AsyncAPI operation object defines (title, summary,
// description, traits, security, tags, external docs, bindings) comes from the template form. The key is generated: a placeholder
// until the user leaves the form, then named from the title or `${action}-${channel}`; the "Identifier" is the only place it shows.
// The parser's own problems still show under the field they belong to.
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { JsonObject, OperationAction } from "@/lib/event-specs/types";
import type { DocChannel, DocOperation, DocReplyAddress, DocumentProblem, EventDocument } from "@/lib/events/document/types";
import { TEMPLATES } from "@/lib/events/templates";
import { autoRenameKey, leftForm, newKey } from "../auto-key";
import { Field, selectClass } from "../controls";
import type { SectionProps } from "../EventBuilder";
import { IdentifierDisclosure } from "../Identifier";
import { problemMessage, problemsByField, uniqueProblems } from "../problems";
import { buildReferenceContext } from "../references";
import { BindingsForm, TemplateForm, type TemplateFormContext } from "../template";
import type { DraftState } from "../use-event-draft";
import { CheckboxGroup, ItemList, Notice, renameAndSelect } from "./ChannelsSection";

const ACTIONS: Array<{ value: OperationAction; title: string; description: string }> = [
  { value: "send", title: "Send", description: "This service publishes" },
  { value: "receive", title: "Receive", description: "This service consumes" },
];
const ACTION_WORDS: Record<string, string> = { send: "Sends", receive: "Receives" };

/** The channel a new reply starts on: another channel when there is one (request/reply usually crosses channels), else this one. */
function defaultReplyChannel(channels: DocChannel[], operationChannel: string): string | undefined {
  return channels.find((c) => c.key !== operationChannel)?.key ?? (channels.some((c) => c.key === operationChannel) ? operationChannel : undefined);
}

/**
 * The operation properties `TemplateForm` draws. `channel`, `messages`, `action`, `reply` and `bindings` are drawn by hand (they must
 * offer valid combinations, or have a form of their own); the template's `traits` is stored as `traitKeys`.
 */
const FORM_KEYS = ["title", "summary", "description", "security", "tags", "externalDocs"] as const;
const HIDDEN_FROM_TEMPLATE = ["action", "channel", "messages", "reply", "bindings"];

function toFormValue(o: DocOperation): Record<string, unknown> {
  const source: Record<string, unknown> = { ...o };
  const value: Record<string, unknown> = {};
  for (const k of FORM_KEYS) if (k in source) value[k] = source[k];
  if (o.traitKeys.length > 0) value.traits = o.traitKeys;
  return value;
}

function applyFormValue(o: DocOperation, next: Record<string, unknown>): DocOperation {
  const out: Record<string, unknown> = { ...o };
  for (const k of FORM_KEYS) delete out[k];
  for (const k of FORM_KEYS) if (k in next) out[k] = next[k];
  out.traitKeys = Array.isArray(next.traits) ? next.traits : [];
  return out as unknown as DocOperation;
}

const toggled = (keys: string[], key: string, on: boolean): string[] =>
  on ? (keys.includes(key) ? keys : [...keys, key]) : keys.filter((k) => k !== key);

const messagesOf = (channels: DocChannel[], channelKey: string | undefined): string[] =>
  channels.find((c) => c.key === channelKey)?.messageKeys ?? [];

/** One sentence naming what a channel change took away. */
function droppedText(dropped: string[], channelKey: string): string {
  return `Removed ${dropped.length === 1 ? "a message" : `${dropped.length} messages`} that ${dropped.length === 1 ? "is" : "are"} not on channel "${channelKey}": ${dropped.join(", ")}.`;
}

export function OperationsSection({ draft, options, selectedItem, onSelectItem, onSectionChange }: SectionProps) {
  const { doc, update } = draft;
  const operations = doc.operations;
  const channels = doc.channels;
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = uniqueProblems(draft.problems.concat(draft.serverProblems));

  const selected = selectedItem === null ? -1 : operations.findIndex((o) => o.key === selectedItem);
  const activeIndex = selected >= 0 ? selected : operations.length > 0 ? 0 : -1;
  const active = activeIndex >= 0 ? operations[activeIndex] : null;
  const needsChannel = channels.length === 0;
  const context = useMemo(() => buildReferenceContext(doc, { entityOptions: options.entityOptions }), [doc, options.entityOptions]);

  function addOperation() {
    if (needsChannel) return;
    const key = newKey(doc, "operation");
    const channelKey = channels[0].key;
    update((d) => ({ ...d, operations: [...d.operations, { key, action: "send", channelKey, messageKeys: [], traitKeys: [] }] }));
    onSelectItem(key);
  }

  const needsChannelNotice = (
    <div data-testid="operation-needs-channel" className="space-y-space-3 rounded-lg border border-dashed border-border p-space-6 text-center">
      <p className="text-heading-3 text-foreground">Add a channel first</p>
      <p className="text-body-small text-muted-foreground">An operation sends or receives messages on a channel, so the event needs at least one.</p>
      {onSectionChange && (
        <Button
          type="button" data-testid="operation-go-channels" className="gap-space-2"
          onClick={() => { onSectionChange("channels"); onSelectItem(null); }}
        >
          Go to Channels
        </Button>
      )}
    </div>
  );

  return (
    <section aria-labelledby="operations-heading" data-testid="section-operations" className="space-y-space-6">
      <header className="flex items-start justify-between gap-space-4">
        <div className="space-y-space-1">
          <h2 id="operations-heading" className="text-heading-3 text-foreground">Operations</h2>
          <p className="text-body-small text-muted-foreground">What this service does: publish messages to a channel or consume them from one.</p>
        </div>
        {operations.length > 0 && !needsChannel && (
          <Button type="button" size="sm" variant="outline" onClick={addOperation} data-testid="operation-add" className="gap-space-2">
            <Plus className="size-4" /> Add operation
          </Button>
        )}
      </header>

      {needsChannel && needsChannelNotice}

      {!active ? (
        !needsChannel && (
          <div data-testid="operation-empty" className="space-y-space-3 rounded-lg border border-dashed border-border p-space-6 text-center">
            <p className="text-heading-3 text-foreground">No operations yet</p>
            <p className="text-body-small text-muted-foreground">An operation says whether this service sends or receives, and which messages.</p>
            <Button type="button" onClick={addOperation} data-testid="operation-empty-add" className="gap-space-2"><Plus className="size-4" /> Add operation</Button>
          </div>
        )
      ) : (
        <div className="grid gap-space-6 md:grid-cols-[14rem_1fr]">
          <ItemList
            label="Operations" prefix="operation" activeIndex={activeIndex} onSelect={onSelectItem}
            items={operations.map((o, i) => ({
              key: o.key, subtitle: `${ACTION_WORDS[o.action] ?? "No action"} · ${o.channelKey || "no channel"}`,
              broken: problemsByField(problems, `/operations/${i}`).length > 0,
            }))}
          />
          <OperationForm key={activeIndex} draft={draft} index={activeIndex} operation={active} problems={problems} context={context} onSelectItem={onSelectItem} />
        </div>
      )}
    </section>
  );
}

function ChannelSelect({ id, label, value, channels, error, required, onChange }: {
  id: string; label: string; value: string; channels: DocChannel[]; error?: string; required?: boolean; onChange: (next: string) => void;
}) {
  const known = channels.some((c) => c.key === value);
  return (
    <Field label={label} htmlFor={id} error={error}>
      <select id={id} data-testid={id} aria-required={required} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {value === "" && <option value="">Select a channel</option>}
        {value !== "" && !known && <option value={value}>{value} (not defined)</option>}
        {channels.map((c) => <option key={c.key} value={c.key}>{c.key}</option>)}
      </select>
    </Field>
  );
}

function OperationForm({ draft, index, operation, problems, context, onSelectItem }: {
  draft: DraftState; index: number; operation: DocOperation; problems: DocumentProblem[]; context: TemplateFormContext;
  onSelectItem: (key: string | null) => void;
}) {
  const { doc, update } = draft;
  const channels = doc.channels;
  const [channelNotice, setChannelNotice] = useState<string | null>(null);
  const [replyNotice, setReplyNotice] = useState<string | null>(null);
  const errorAt = (suffix: string) => problemMessage(problemsByField(problems, `/operations/${index}${suffix}`));
  const replyError = problemMessage(problems.filter((p) => p.pointer === `/operations/${index}/reply`));

  function patch(change: (o: DocOperation) => DocOperation) {
    update((d) => ({ ...d, operations: d.operations.map((o, i) => (i === index ? change(o) : o)) }));
  }

  /** Once the user leaves the form: a placeholder key becomes a name from the title, or `${action}-${channel}`. Later edits never rename it again. */
  function nameKeyFromContent() {
    const from = operation.key;
    const values = (d: EventDocument) => {
      const o = d.operations.find((x) => x.key === from);
      return { title: o?.title, action: o?.action, channel: o?.channelKey };
    };
    const preview = autoRenameKey(doc, "operation", from, values(doc));
    if (preview === doc) return;
    update((d) => autoRenameKey(d, "operation", from, values(d)));
    onSelectItem(preview.operations[index].key);
  }

  function changeChannel(next: string) {
    const allowed = new Set(messagesOf(channels, next));
    const dropped = operation.messageKeys.filter((k) => !allowed.has(k));
    patch((o) => ({ ...o, channelKey: next, messageKeys: o.messageKeys.filter((k) => allowed.has(k)) }));
    setChannelNotice(dropped.length > 0 ? droppedText(dropped, next) : null);
  }

  function toggleMessage(key: string, on: boolean) {
    setChannelNotice(null);
    patch((o) => ({ ...o, messageKeys: toggled(o.messageKeys, key, on) }));
  }

  function toggleReply(on: boolean) {
    setReplyNotice(null);
    patch((o) => {
      const next = { ...o };
      if (!on) {
        delete next.reply;
        return next;
      }
      const channelKey = defaultReplyChannel(channels, o.channelKey);
      next.reply = { ...(channelKey ? { channelKey } : {}), messageKeys: [] };
      return next;
    });
  }

  function changeReplyChannel(next: string) {
    const allowed = new Set(messagesOf(channels, next));
    const dropped = (operation.reply?.messageKeys ?? []).filter((k) => !allowed.has(k));
    patch((o) => ({ ...o, reply: { ...o.reply, channelKey: next, messageKeys: (o.reply?.messageKeys ?? []).filter((k) => allowed.has(k)) } }));
    setReplyNotice(dropped.length > 0 ? droppedText(dropped, next) : null);
  }

  function toggleReplyMessage(key: string, on: boolean) {
    setReplyNotice(null);
    patch((o) => ({ ...o, reply: { ...o.reply, messageKeys: toggled(o.reply?.messageKeys ?? [], key, on) } }));
  }

  function changeReplyAddress(next: Record<string, unknown>) {
    patch((o) => {
      const nextReply = { ...o.reply };
      if (Object.keys(next).length === 0) delete nextReply.address;
      else nextReply.address = next as unknown as DocReplyAddress;
      return { ...o, reply: nextReply };
    });
  }

  function changeBindings(next: Record<string, unknown>) {
    patch((o) => {
      if (Object.keys(next).length === 0) {
        const copy = { ...o };
        delete copy.bindings;
        return copy;
      }
      return { ...o, bindings: next as JsonObject };
    });
  }

  function remove() {
    update((d) => ({ ...d, operations: d.operations.filter((_, i) => i !== index) }));
    onSelectItem(null);
  }

  const channelExists = channels.some((c) => c.key === operation.channelKey);
  const reply = operation.reply;
  const replyChannelExists = reply?.channelKey !== undefined && channels.some((c) => c.key === reply.channelKey);
  const actionError = errorAt("/action");
  const actionErrorId = "operation-action-error";

  return (
    <div className="max-w-2xl space-y-space-4" data-testid="operation-form">
      <div onBlur={(e) => { if (leftForm(e)) nameKeyFromContent(); }} className="space-y-space-4">
        <fieldset id="operation-action" data-testid="operation-action" aria-describedby={actionError ? actionErrorId : undefined} className="space-y-space-2">
          <legend className="text-caption text-muted-foreground">Action</legend>
          <div className="grid gap-space-3 sm:grid-cols-2">
            {ACTIONS.map((a) => {
              const id = `operation-action-${a.value}`;
              const checked = operation.action === a.value;
              return (
                <label
                  key={a.value} htmlFor={id}
                  className={cn(
                    "flex cursor-pointer items-start gap-space-3 rounded-lg border p-space-3 transition-colors focus-within:ring-3 focus-within:ring-ring/50",
                    checked ? "border-primary bg-muted" : "border-border hover:bg-muted/60",
                  )}
                >
                  <input
                    id={id} data-testid={id} type="radio" name="operation-action" value={a.value} checked={checked}
                    onChange={() => patch((o) => ({ ...o, action: a.value }))} className="mt-1 size-4 shrink-0 accent-primary"
                  />
                  <span>
                    <span className="block text-body-small font-medium text-foreground">{a.title}</span>
                    <span className="block text-caption text-muted-foreground">{a.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {actionError && <p id={actionErrorId} data-testid={actionErrorId} className="text-body-small text-destructive">{actionError}</p>}
        </fieldset>

        <ChannelSelect
          id="operation-channel" label="Channel" required value={operation.channelKey} channels={channels}
          error={errorAt("/channelKey")} onChange={changeChannel}
        />
        {channelNotice && <Notice id="operation-channel-notice">{channelNotice}</Notice>}

        <CheckboxGroup
          id="operation-messages" label="Messages" checked={operation.messageKeys} onToggle={toggleMessage}
          options={messagesOf(channels, operation.channelKey).map((k) => ({ value: k, label: k }))}
          strayLabel="not on this channel" error={errorAt("/messageKeys")}
          empty={channelExists
            ? `Channel "${operation.channelKey}" has no messages yet. Allow messages on it in Channels or Messages; an operation can be saved without any.`
            : "Choose a channel to see the messages it allows."}
          hint="Only messages allowed on the chosen channel are listed."
        />

        <TemplateForm
          template={TEMPLATES.operation} value={toFormValue(operation)} idPrefix="operation" errors={problems}
          errorPrefix={`/operations/${index}`} context={context} hideKeys={HIDDEN_FROM_TEMPLATE}
          onChange={(next) => patch((o) => applyFormValue(o, next))}
        />

        <section aria-labelledby="operation-reply-heading" data-testid="operation-reply" className="space-y-space-3 rounded-lg border border-border p-space-4">
          <h3 id="operation-reply-heading" className="text-body font-medium text-foreground">Reply</h3>
          <label className="flex items-center gap-space-2 text-body-small text-foreground">
            <input
              type="checkbox" data-testid="operation-reply-toggle" className="size-4 shrink-0 accent-primary"
              checked={reply !== undefined} aria-describedby={replyError ? "operation-reply-error" : undefined}
              onChange={(e) => toggleReply(e.target.checked)}
            />
            <span>This operation expects a reply</span>
          </label>
          {replyError && <p id="operation-reply-error" data-testid="operation-reply-error" className="text-body-small text-destructive">{replyError}</p>}
          {reply !== undefined && (
            <div className="space-y-space-3">
              <ChannelSelect
                id="operation-reply-channel" label="Reply channel" value={reply.channelKey ?? ""} channels={channels}
                error={errorAt("/reply/channelKey")} onChange={changeReplyChannel}
              />
              {replyNotice && <Notice id="operation-reply-notice">{replyNotice}</Notice>}
              <CheckboxGroup
                id="operation-reply-messages" label="Reply messages" checked={reply.messageKeys ?? []} onToggle={toggleReplyMessage}
                options={messagesOf(channels, reply.channelKey).map((k) => ({ value: k, label: k }))}
                strayLabel="not on this channel" error={errorAt("/reply/messageKeys")}
                empty={replyChannelExists
                  ? `Channel "${reply.channelKey}" has no messages yet. Allow messages on it in Channels or Messages.`
                  : "Choose a reply channel to see the messages it allows."}
              />
              <TemplateForm
                template={TEMPLATES.operationReplyAddress} value={{ ...reply.address }} idPrefix="operation-reply-address" errors={problems}
                errorPrefix={`/operations/${index}/reply/address`} onChange={changeReplyAddress}
              />
            </div>
          )}
        </section>

        <BindingsForm
          target="operation" suggestedProtocol={channels.find((c) => c.key === operation.channelKey)?.protocol} value={operation.bindings ?? {}}
          idPrefix="operation-bindings" errors={problems} errorPrefix={`/operations/${index}/bindings`} onChange={changeBindings}
        />
      </div>

      <IdentifierDisclosure
        id="operation-key" value={operation.key} error={errorAt("/key")}
        taken={doc.operations.filter((_, i) => i !== index).map((o) => o.key)}
        onRename={(to) => renameAndSelect(draft, "operation", operation.key, to, onSelectItem)}
      />

      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={remove} data-testid="operation-remove" className="gap-space-2 text-muted-foreground hover:text-destructive">
          <Trash2 className="size-4" /> Remove operation
        </Button>
      </div>
    </div>
  );
}
