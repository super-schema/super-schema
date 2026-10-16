"use client";

// src/features/events/builder/sections/MessagesSection.tsx
// Messages: a list on the left and, on the right, the payload (entity + version, headers, key, and the payload representation:
// Auto picks Avro / JSON Schema / Protobuf from the entity and the channel, or the user chooses), then every other property of the
// AsyncAPI message from the template form, the protocol bindings and the channels the message is sent on (which mirrors
// `channels[].messageKeys`). The key is generated: a placeholder until the user leaves the form, then named from the name or title;
// the "Identifier" below the form is the only place it shows. Every edit goes through `draft.update(fn)`.
import { lazy, Suspense, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JsonObject, PayloadFormat } from "@/lib/event-specs/types";
import type { DocMessage, DocOperation, DocumentProblem, EventDocument } from "@/lib/events/document/types";
import { TEMPLATES, type ObjectTemplate } from "@/lib/events/templates";
import type { EntityPin } from "@/lib/events/types";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { autoRenameKey, leftForm, newKey } from "../auto-key";
import type { SectionProps } from "../EventBuilder";
import { IdentifierDisclosure } from "../Identifier";
import { problemMessage, problemsByField, uniqueProblems } from "../problems";
import { buildReferenceContext } from "../references";
import { BindingsForm, TemplateForm, type TemplateFormContext } from "../template";
import type { DraftState } from "../use-event-draft";
import {
  aliasPointers, allMessageKeys, blockedText, channelLabel, CheckboxGroup, ItemList, messageLabel, Notice, plural, renameAndSelect, setMessageAllowed,
} from "./graph-parts";
import { representationNote } from "./representation-note";
import { RepresentationSelect } from "./RepresentationSelect";

// The picker pulls in a server-action module (versions are loaded through it). Loading it lazily keeps that chain out of every
// module graph that merely imports the builder, and out of the first paint of the other sections.
const EntityPinPicker = lazy(() => import("@/features/events/shared/EntityPinPicker").then((m) => ({ default: m.EntityPinPicker })));

const NO_PAYLOAD: EntityPin = { entityId: "", entityVersionId: null };

/**
 * The properties the template form draws, as the document stores them (the template's `traits` is the document's `traitKeys`).
 * The entity pins (`payload`, `headers`, `keyPin`) and `bindings` are drawn by hand: the pins need the entity picker and its
 * version badges, the bindings have a form of their own. `representation` is not an AsyncAPI property: it has its own select.
 */
const FORM_KEYS = ["name", "title", "summary", "description", "contentType", "correlationId", "examples", "tags", "externalDocs", "deprecated"] as const;
const HIDDEN_FROM_TEMPLATE = ["payload", "headers", "keyPin", "bindings"];

function toFormValue(m: DocMessage): Record<string, unknown> {
  const source = m as unknown as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  for (const k of FORM_KEYS) if (k in source) value[k] = source[k];
  if (m.traitKeys.length > 0) value.traits = m.traitKeys;
  return value;
}

function applyFormValue(m: DocMessage, next: Record<string, unknown>): DocMessage {
  const out: Record<string, unknown> = { ...m };
  for (const k of FORM_KEYS) delete out[k];
  for (const k of FORM_KEYS) if (k in next) out[k] = next[k];
  out.traitKeys = Array.isArray(next.traits) ? next.traits.filter((k): k is string => typeof k === "string") : [];
  return out as unknown as DocMessage;
}

/** The message template, with the document's default content type shown as the placeholder of the message's own. */
function templateFor(defaultContentType: string | undefined): ObjectTemplate {
  if (!defaultContentType) return TEMPLATES.message;
  return {
    ...TEMPLATES.message,
    fields: TEMPLATES.message.fields.map((f) => (f.key === "contentType" ? { ...f, placeholder: `${defaultContentType} (the document's default)` } : f)),
  };
}

/** An entity + version picker with its error underneath, linked to it with `aria-describedby` on the wrapping group. */
function PinField({ id, label, hint, optional, entities, value, onChange, error }: {
  id: string; label: string; hint?: string; optional?: boolean; entities: EntityOption[]; value: EntityPin | null;
  onChange: (pin: EntityPin | null) => void; error?: string;
}) {
  const errorId = `${id}-error`;
  return (
    <div role="group" data-testid={`${id}-group`} aria-describedby={error ? errorId : undefined} className="space-y-space-1">
      <Suspense fallback={<p data-testid={`${id}-loading`} className="text-caption text-muted-foreground">{label}: loading…</p>}>
        <EntityPinPicker id={id} label={label} hint={hint} optional={optional} entities={entities} value={value} onChange={onChange} />
      </Suspense>
      {error && <p id={errorId} data-testid={errorId} className="text-body-small text-destructive">{error}</p>}
    </div>
  );
}

/** `doc` without `messageKey` anywhere: channels, operations and operation replies. Untouched items keep their identity. */
function withoutMessage(doc: EventDocument, messageKey: string): EventDocument {
  const dropFromOperation = (o: DocOperation): DocOperation => {
    const inOwn = o.messageKeys.includes(messageKey);
    const inReply = o.reply?.messageKeys?.includes(messageKey) ?? false;
    if (!inOwn && !inReply) return o;
    const next: DocOperation = { ...o, messageKeys: o.messageKeys.filter((k) => k !== messageKey) };
    if (o.reply?.messageKeys) next.reply = { ...o.reply, messageKeys: o.reply.messageKeys.filter((k) => k !== messageKey) };
    return next;
  };
  return {
    ...doc,
    channels: doc.channels.map((c) => (c.messageKeys.includes(messageKey) ? { ...c, messageKeys: c.messageKeys.filter((k) => k !== messageKey) } : c)),
    operations: doc.operations.map(dropFromOperation),
  };
}

export function MessagesSection({ draft, options, selectedItem, onSelectItem }: SectionProps) {
  const { doc, update } = draft;
  const messages = doc.messages;
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = useMemo(() => uniqueProblems(draft.problems.concat(draft.serverProblems)), [draft.problems, draft.serverProblems]);
  const context = useMemo(() => buildReferenceContext(doc, { entityOptions: options.entityOptions }), [doc, options.entityOptions]);

  const selected = selectedItem === null ? -1 : messages.findIndex((m) => m.key === selectedItem);
  const activeIndex = selected >= 0 ? selected : messages.length > 0 ? 0 : -1;
  const active = activeIndex >= 0 ? messages[activeIndex] : null;

  function addMessage() {
    // A placeholder key, named from the name or title once the user leaves the form.
    const key = newKey(doc, "message");
    update((d) => ({ ...d, messages: [...d.messages, { key, payload: NO_PAYLOAD, traitKeys: [] }] }));
    onSelectItem(key);
  }

  const entityName = (pin: EntityPin) => options.entityOptions.find((e) => e.id === pin.entityId)?.name;

  return (
    <section aria-labelledby="messages-heading" data-testid="section-messages" className="space-y-space-6">
      <header className="flex items-start justify-between gap-space-4">
        <div className="space-y-space-1">
          <h2 id="messages-heading" className="text-heading-3 text-foreground">Messages</h2>
          <p className="text-body-small text-muted-foreground">What is sent. Each message carries one entity as its payload and is allowed on one or more channels.</p>
        </div>
        {messages.length > 0 && (
          <Button type="button" size="sm" variant="outline" onClick={addMessage} data-testid="message-add" className="gap-space-2">
            <Plus className="size-4" /> Add message
          </Button>
        )}
      </header>

      {!active ? (
        <div data-testid="message-empty" className="space-y-space-3 rounded-lg border border-dashed border-border p-space-6 text-center">
          <p className="text-heading-3 text-foreground">No messages yet</p>
          <p className="text-body-small text-muted-foreground">A message pairs a name with the entity that describes its payload.</p>
          <Button type="button" onClick={addMessage} data-testid="message-empty-add" className="gap-space-2"><Plus className="size-4" /> Add message</Button>
        </div>
      ) : (
        <div className="grid gap-space-6 md:grid-cols-[14rem_1fr]">
          <ItemList
            label="Messages" prefix="message" activeIndex={activeIndex} onSelect={onSelectItem}
            items={messages.map((m, i) => ({
              key: m.key, label: messageLabel(m), subtitle: (m.payload.entityId && entityName(m.payload)) || "No payload",
              broken: problemsByField(problems, `/messages/${i}`).length > 0,
            }))}
          />
          <MessageForm
            key={activeIndex} draft={draft} options={options} index={activeIndex} message={active} problems={problems} context={context}
            onSelectItem={onSelectItem}
          />
        </div>
      )}
    </section>
  );
}

function MessageForm({ draft, options, index, message, problems, context, onSelectItem }: {
  draft: DraftState; options: SectionProps["options"]; index: number; message: DocMessage; problems: DocumentProblem[];
  context: TemplateFormContext; onSelectItem: (key: string | null) => void;
}) {
  const { doc, update } = draft;
  const [blocked, setBlocked] = useState<string | null>(null);
  const prefix = `/messages/${index}`;
  const errorAt = (suffix: string) => problemMessage(problemsByField(problems, `${prefix}${suffix}`));
  // The document stores `traitKeys`; the template form shows problems under the AsyncAPI name.
  const formProblems = useMemo(() => aliasPointers(problems, prefix, { traitKeys: "traits" }), [problems, prefix]);
  const template = useMemo(() => templateFor(doc.defaultContentType), [doc.defaultContentType]);
  const note = useMemo(() => representationNote(doc, message.key, options.entityOptions), [doc, message.key, options.entityOptions]);

  function patch(change: (m: DocMessage) => DocMessage) {
    update((d) => ({ ...d, messages: d.messages.map((m, i) => (i === index ? change(m) : m)) }));
  }

  /** Once the user leaves the form: a placeholder key becomes a name from the name or title. Later edits never rename it again. */
  function nameKeyFromContent() {
    const from = message.key;
    const values = (d: EventDocument) => {
      const m = d.messages.find((x) => x.key === from);
      return { name: m?.name, title: m?.title };
    };
    const preview = autoRenameKey(doc, "message", from, values(doc));
    if (preview === doc) return;
    update((d) => autoRenameKey(d, "message", from, values(d)));
    onSelectItem(preview.messages[index].key);
  }

  function setOptionalPin(field: "headers" | "keyPin", pin: EntityPin | null) {
    patch((m) => {
      const next = { ...m };
      if (pin) next[field] = pin;
      else delete next[field];
      return next;
    });
  }

  function setRepresentation(value: "" | PayloadFormat) {
    patch((m) => {
      const next = { ...m };
      if (value === "") delete next.representation;
      else next.representation = value;
      return next;
    });
  }

  function setBindings(next: Record<string, unknown>) {
    patch((m) => {
      if (Object.keys(next).length === 0) {
        const copy = { ...m };
        delete copy.bindings;
        return copy;
      }
      return { ...m, bindings: next as JsonObject };
    });
  }

  function toggleChannel(channelKey: string, on: boolean) {
    const result = setMessageAllowed(doc, channelKey, message.key, on);
    if ("blockedBy" in result) {
      setBlocked(blockedText(message.key, channelKey, result.blockedBy));
      return;
    }
    setBlocked(null);
    update((d) => {
      const next = setMessageAllowed(d, channelKey, message.key, on);
      return "doc" in next ? next.doc : d;
    });
  }

  function remove() {
    const key = message.key;
    const channelsUsing = doc.channels.filter((c) => c.messageKeys.includes(key));
    const operationsUsing = doc.operations.filter((o) => o.messageKeys.includes(key) || (o.reply?.messageKeys ?? []).includes(key));
    if (channelsUsing.length + operationsUsing.length > 0) {
      const where = [
        channelsUsing.length > 0 ? `${plural(channelsUsing.length, "channel")} (${channelsUsing.map((c) => c.key).join(", ")})` : null,
        operationsUsing.length > 0 ? `${plural(operationsUsing.length, "operation")} (${operationsUsing.map((o) => o.key).join(", ")})` : null,
      ].filter(Boolean).join(" and ");
      if (!window.confirm(`Message "${key}" is used by ${where}. Remove it and take it out of ${channelsUsing.length + operationsUsing.length === 1 ? "that item" : "those items"}?`)) return;
    }
    update((d) => {
      const messagesLeft = d.messages.filter((_, i) => i !== index);
      const stillDefined = messagesLeft.some((m) => m.key === key) || d.externalRefs.some((r) => r.kind === "message" && r.key === key);
      return stillDefined ? { ...d, messages: messagesLeft } : withoutMessage({ ...d, messages: messagesLeft }, key);
    });
    onSelectItem(null);
  }

  const sentOn = doc.channels.filter((c) => c.messageKeys.includes(message.key)).map((c) => c.key);
  const carrier = doc.channels.find((c) => c.messageKeys.includes(message.key));

  return (
    <div className="max-w-2xl space-y-space-4" data-testid="message-form">
      <div onBlur={(e) => { if (leftForm(e)) nameKeyFromContent(); }} className="space-y-space-6">
        <section aria-labelledby="message-payload-heading" className="space-y-space-4 rounded-lg border border-border p-space-4">
          <h3 id="message-payload-heading" className="text-body font-medium text-foreground">Payload</h3>
          <PinField
            id="payload" label="Payload" entities={options.entityOptions} error={errorAt("/payload")}
            hint="Required. The entity this message carries."
            value={message.payload.entityId ? message.payload : null}
            onChange={(pin) => patch((m) => ({ ...m, payload: pin ?? NO_PAYLOAD }))}
          />
          <RepresentationSelect
            id="message-representation" value={message.representation ?? ""} note={note} error={errorAt("/representation")}
            onChange={setRepresentation}
          />
          <PinField
            id="headers" label="Headers" optional entities={options.entityOptions} error={errorAt("/headers")}
            value={message.headers ?? null} onChange={(pin) => setOptionalPin("headers", pin)}
          />
          <PinField
            id="key-pin" label="Message key" optional entities={options.entityOptions} error={errorAt("/keyPin")}
            hint="Optional. The entity describing the record key, for example a Kafka key."
            value={message.keyPin ?? null} onChange={(pin) => setOptionalPin("keyPin", pin)}
          />
        </section>

        <section aria-labelledby="message-details-heading" className="space-y-space-4 rounded-lg border border-border p-space-4">
          <h3 id="message-details-heading" className="text-body font-medium text-foreground">Details</h3>
          <TemplateForm
            template={template} value={toFormValue(message)} idPrefix="message" errors={formProblems} errorPrefix={prefix}
            context={context} hideKeys={HIDDEN_FROM_TEMPLATE}
            onChange={(next) => patch((m) => applyFormValue(m, next))}
          />
        </section>

        <BindingsForm
          target="message" suggestedProtocol={carrier?.protocol} value={message.bindings ?? {}} idPrefix="message-bindings"
          errors={problems} errorPrefix={`${prefix}/bindings`} onChange={setBindings}
        />

        <CheckboxGroup
          id="message-channels" label="Sent on channels" checked={sentOn} onToggle={toggleChannel}
          options={doc.channels.map((c) => ({ value: c.key, label: channelLabel(c) }))}
          empty="No channels yet. Add a channel first, then choose it here."
          hint="Operations can only use a message on the channels that allow it."
        />
        {blocked && <Notice id="message-channels-blocked">{blocked}</Notice>}
      </div>

      <IdentifierDisclosure
        id="message-key" value={message.key} error={errorAt("/key")}
        taken={allMessageKeys({ ...doc, messages: doc.messages.filter((_, i) => i !== index) })}
        onRename={(to) => renameAndSelect(draft, "message", message.key, to, onSelectItem)}
      />

      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={remove} data-testid="message-remove" className="gap-space-2 text-muted-foreground hover:text-destructive">
          <Trash2 className="size-4" /> Remove message
        </Button>
      </div>
    </div>
  );
}
