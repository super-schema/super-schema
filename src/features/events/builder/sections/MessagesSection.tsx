"use client";

// src/features/events/builder/sections/MessagesSection.tsx
// Messages: a tab strip of the messages (`ItemTabs`) and, under it, the message as a rail of panes (`PaneRail`) so the form is not one long
// wall of fields and the pane being worked on gets the whole height:
//   Payload (entity + version, payload representation, headers, message key) · Message properties (Trait) · Details (name, title,
//   summary, description, content type) · Sent on channels · Examples · Bindings · Docs & tags · Correlation id · More
// Above the rail one line says which channels the message is sent on. Every pane with something in it shows how many fields are set; the
// pane that shows is kept while switching from one message to another, and a pane that holds a problem shows by itself. The key is
// generated: a placeholder until the user leaves the form, then named from the name or title; the "Identifier" below the rail is the
// only place it shows. Every edit goes through `draft.update(fn)`.
// Under the list sits the card of EXTERNAL messages (messages another published event defines and this one uses): `ExternalRefsCard`.
import { lazy, Suspense, useMemo, useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JsonObject, PayloadFormat } from "@/lib/event-specs/types";
import type { DocMessage, DocumentProblem, EventDocument } from "@/lib/events/document/types";
import { TEMPLATES, type ObjectTemplate } from "@/lib/events/templates";
import type { EntityPin } from "@/lib/events/types";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { autoRenameKey, leftForm, newKey } from "../auto-key";
import type { SectionProps } from "../EventBuilder";
import { IdentifierDisclosure } from "../Identifier";
import { messagePropertiesTitle } from "../labels";
import { problemMessage, problemsByField, uniqueProblems } from "../problems";
import { buildReferenceContext } from "../references";
import { BindingsForm, TemplateForm, type TemplateFormContext } from "../template";
import type { DraftState } from "../use-event-draft";
import { usePinJsonSchemaState } from "../use-pin-json-schema";
import {
  allMessageKeys, blockedText, channelLabel, CheckboxGroup, messageLabel, Notice, plural, renameAndSelect, setMessageAllowed,
} from "./graph-parts";
import { bindingCount, cardsWithProblems, cardTemplate, mergeValue, pickValue, setFieldCount } from "./form-cards";
import { ExternalRefsCard } from "./ExternalRefsCard";
import { MessagePropertiesCard } from "./MessagePropertiesCard";
import { ItemTabs } from "./ItemTabs";
import { duplicateMessage, removeMessageAt } from "./message-actions";
import { useAfterDelay } from "./use-after-delay";
import { useUndoToast } from "./use-undo-toast";
import { OptionalPin } from "./OptionalPin";
import { PayloadPreview } from "./PayloadPreview";
import { PaneRail, usePaneState, type PaneDef, type PaneState } from "./PaneRail";
import { representationNote } from "./representation-note";
import { RepresentationSelect } from "./RepresentationSelect";
import { SectionHeading } from "./SectionHeading";

// The picker pulls in a server-action module (versions are loaded through it). Loading it lazily keeps that chain out of every
// module graph that merely imports the builder, and out of the first paint of the other sections.
const EntityPinPicker = lazy(() => import("@/features/events/shared/EntityPinPicker").then((m) => ({ default: m.EntityPinPicker })));

const NO_PAYLOAD: EntityPin = { entityId: "", entityVersionId: null };

/**
 * The properties the template form draws, as the document stores them (the template's `traits` is the document's `traitKeys`, drawn by the
 * Message properties card). The entity pins (`payload`, `headers`, `keyPin`) and `bindings` are drawn by hand: the pins need the entity picker
 * and its version badges, the bindings have a form of their own. `representation` is not an AsyncAPI property: it has its own select.
 */
const FORM_KEYS = ["name", "title", "summary", "description", "contentType", "correlationId", "examples", "tags", "externalDocs", "deprecated"] as const;

/** The template fields each card draws (the cards that are not just a template form are not listed). */
const DETAILS_KEYS = ["name", "title", "summary", "description", "contentType"] as const;
const EXAMPLES_KEYS = ["examples"] as const;
const DOCS_KEYS = ["tags", "externalDocs"] as const;
const CORRELATION_KEYS = ["correlationId"] as const;
const MORE_KEYS = ["deprecated"] as const;

/** Which part of the message each pane draws, for showing the pane that holds a problem. */
const CARD_POINTERS: Record<string, readonly string[]> = {
  payload: ["payload", "representation", "headers", "keyPin"],
  properties: ["traitKeys"],
  details: DETAILS_KEYS,
  examples: EXAMPLES_KEYS,
  bindings: ["bindings"],
  docs: DOCS_KEYS,
  correlation: CORRELATION_KEYS,
  more: MORE_KEYS,
};

/** How long a message has to stay on screen before its payload preview is requested, in milliseconds. */
const PREVIEW_DELAY_MS = 300;

/** The pane that shows on first sight, and the panes built up front (the others are built the first time they show). */
const DEFAULT_PANE = "payload";
const KEEP_MOUNTED = ["payload", "properties", "details", "channels"] as const;

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
function PinField({ id, label, hint, optional, entities, value, onChange, error, autoFocus }: {
  id: string; label: string; hint?: string; optional?: boolean; entities: EntityOption[]; value: EntityPin | null;
  onChange: (pin: EntityPin | null) => void; error?: string; autoFocus?: boolean;
}) {
  const errorId = `${id}-error`;
  return (
    <div role="group" data-testid={`${id}-group`} aria-describedby={error ? errorId : undefined} className="space-y-space-1">
      <Suspense fallback={<p data-testid={`${id}-loading`} className="text-caption text-muted-foreground">{label}: loading…</p>}>
        <EntityPinPicker id={id} label={label} hint={hint} optional={optional} entities={entities} value={value} onChange={onChange} autoFocus={autoFocus} />
      </Suspense>
      {error && <p id={errorId} data-testid={errorId} className="text-body-small text-destructive">{error}</p>}
    </div>
  );
}

export function MessagesSection({ draft, options, selectedItem, onSelectItem, onSectionChange }: SectionProps) {
  const { doc, update } = draft;
  const messages = doc.messages;
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = useMemo(() => uniqueProblems(draft.problems.concat(draft.serverProblems)), [draft.problems, draft.serverProblems]);
  const context = useMemo(() => buildReferenceContext(doc, { entityOptions: options.entityOptions }), [doc, options.entityOptions]);

  const selected = selectedItem === null ? -1 : messages.findIndex((m) => m.key === selectedItem);
  const activeIndex = selected >= 0 ? selected : messages.length > 0 ? 0 : -1;
  const active = activeIndex >= 0 ? messages[activeIndex] : null;
  // Which pane shows lives here, not in the form: the form is rebuilt for every message, the choice must survive.
  const errored = useMemo(() => cardsWithProblems(problems, `/messages/${activeIndex}`, CARD_POINTERS), [problems, activeIndex]);
  const pane = usePaneState(DEFAULT_PANE, errored);

  // The message just added starts with the cursor in its payload picker, on the Payload pane; moving to another message ends that.
  const [addedKey, setAddedKey] = useState<string | null>(null);
  const offerUndo = useUndoToast(doc);
  // Raised when a message is removed: the cursor goes to the strip, since the form it was in is gone.
  const [stripFocus, setStripFocus] = useState(0);
  function addMessage() {
    // A placeholder key, named from the name or title once the user leaves the form.
    const key = newKey(doc, "message");
    update((d) => ({ ...d, messages: [...d.messages, { key, payload: NO_PAYLOAD, traitKeys: [] }] }));
    setAddedKey(key);
    pane.select("payload");
    onSelectItem(key);
  }
  const selectMessage = (key: string) => {
    setAddedKey(null);
    onSelectItem(key);
  };

  const entityName = (pin: EntityPin) => options.entityOptions.find((e) => e.id === pin.entityId)?.name;

  return (
    <section aria-labelledby="messages-heading" data-testid="section-messages" className="space-y-space-6">
      <SectionHeading section="messages" title="Messages">
        What is sent. Each message carries one entity as its payload and is allowed on one or more channels.
      </SectionHeading>

      {!active ? (
        <div data-testid="message-empty" className="space-y-space-3 rounded-lg border border-dashed border-border p-space-6 text-center">
          <p className="text-heading-3 text-foreground">No messages yet</p>
          <p className="text-body-small text-muted-foreground">A message pairs a name with the entity that describes its payload.</p>
          <Button type="button" onClick={addMessage} data-testid="message-empty-add" className="gap-space-2"><Plus className="size-4" /> Add message</Button>
        </div>
      ) : (
        <div className="space-y-space-4">
          <ItemTabs
            label="Messages" prefix="message" activeIndex={activeIndex} onSelect={selectMessage}
            onAdd={addMessage} addLabel="Add message" addTestId="message-add" focusSignal={stripFocus}
            items={messages.map((m, i) => ({
              key: m.key, label: messageLabel(m), subtitle: (m.payload.entityId && entityName(m.payload)) || "No payload",
              broken: problemsByField(problems, `/messages/${i}`).length > 0,
            }))}
          />
          <MessageForm
            key={activeIndex} draft={draft} options={options} index={activeIndex} message={active} problems={problems} context={context}
            pane={pane} errored={errored} autoFocusPayload={active.key === addedKey} offerUndo={offerUndo} onRemoved={() => setStripFocus((n) => n + 1)} onSelectItem={onSelectItem} onSectionChange={onSectionChange}
          />
        </div>
      )}

      <ExternalRefsCard kind="message" draft={draft} problems={problems} />
    </section>
  );
}

function MessageForm({ draft, options, index, message, problems, context, pane, errored, autoFocusPayload, offerUndo, onRemoved, onSelectItem, onSectionChange }: {
  draft: DraftState; options: SectionProps["options"]; index: number; message: DocMessage; problems: DocumentProblem[];
  context: TemplateFormContext; pane: PaneState; errored: ReadonlySet<string>; autoFocusPayload: boolean; offerUndo: ReturnType<typeof useUndoToast>; onRemoved: () => void; onSelectItem: (key: string | null) => void; onSectionChange?: SectionProps["onSectionChange"];
}) {
  const { doc, update } = draft;
  const [blocked, setBlocked] = useState<string | null>(null);
  const prefix = `/messages/${index}`;
  const errorAt = (suffix: string) => problemMessage(problemsByField(problems, `${prefix}${suffix}`));
  const template = useMemo(() => templateFor(doc.defaultContentType), [doc.defaultContentType]);
  const note = useMemo(() => representationNote(doc, message.key, options.entityOptions), [doc, message.key, options.entityOptions]);
  // The examples are checked against the schema of the message's own payload / headers entity. The schemas are rendered by the server
  // (the TypeSpec compiler), so they are asked for only while an example is on screen. A pin without a schema is `null`.
  // The payload's schema is also what the Payload pane previews: one request serves both panes.
  // The preview waits until the user has stopped on the message for a moment: the schema costs the server a compiler run, and a user
  // arrowing through the strip would otherwise queue one per tab. The examples were asked for by opening them: no wait there.
  const examplesShown = pane.active === "examples" && (message.examples?.length ?? 0) > 0;
  const previewDue = useAfterDelay(pane.active === "payload", PREVIEW_DELAY_MS);
  const payloadSchema = usePinJsonSchemaState(draft.productId, message.payload, examplesShown || previewDue);
  const headersSchema = usePinJsonSchemaState(draft.productId, message.headers, examplesShown);
  const exampleContext = useMemo<TemplateFormContext>(
    () => ({
      ...context,
      pinSchemas: { payload: payloadSchema.schema, headers: headersSchema.schema },
      pinSchemasLoading: { payload: payloadSchema.loading, headers: headersSchema.loading },
    }),
    [context, payloadSchema.schema, payloadSchema.loading, headersSchema.schema, headersSchema.loading],
  );

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
    const where = [
      channelsUsing.length > 0 ? `${plural(channelsUsing.length, "channel")} (${channelsUsing.map((c) => c.key).join(", ")})` : null,
      operationsUsing.length > 0 ? `${plural(operationsUsing.length, "operation")} (${operationsUsing.map((o) => o.key).join(", ")})` : null,
    ].filter(Boolean).join(" and ");
    // No confirmation: the removal is undone from the toast, which restores the document exactly as it was.
    const before = doc;
    const after = removeMessageAt(before, index);
    update(() => after);
    onSelectItem(null);
    onRemoved();
    // Undo brings the document back and selects the message again (it may be far down a long strip).
    offerUndo(where === "" ? `Removed "${key}"` : `Removed "${key}" and took it out of ${where}`, after, () => {
      update((d) => (d === after ? before : d));
      onSelectItem(key);
    });
  }

  function duplicate() {
    const copy = duplicateMessage(doc, message.key);
    if (!copy) return;
    update(() => copy.doc);
    onSelectItem(copy.key);
  }

  const entityOf = (pin: EntityPin) => options.entityOptions.find((e) => e.id === pin.entityId);
  const sentOnChannels = doc.channels.filter((c) => c.messageKeys.includes(message.key));
  const sentOn = sentOnChannels.map((c) => c.key);
  const carrier = sentOnChannels[0];
  const formValue = toFormValue(message);

  /** A template form for the fields of one pane: it sees only its own keys and its edits are merged back into the message. */
  const cardForm = (keys: readonly string[], formContext: TemplateFormContext = context) => (
    <TemplateForm
      template={cardTemplate(template, keys)} value={pickValue(formValue, keys)} idPrefix="message" errors={problems} errorPrefix={prefix}
      context={formContext} compactHelp
      onChange={(next) => patch((m) => applyFormValue(m, mergeValue(toFormValue(m), keys, next)))}
    />
  );

  const payloadBody = (
    <>
      <div data-testid="payload-row" className="flex flex-wrap items-start gap-x-space-4 gap-y-space-3">
        <div className="min-w-0 flex-1 basis-64">
          <PinField
            id="payload" label="Payload" entities={options.entityOptions} error={errorAt("/payload")} autoFocus={autoFocusPayload}
            hint="Required. The entity this message carries."
            value={message.payload.entityId ? message.payload : null}
            onChange={(pin) => patch((m) => ({ ...m, payload: pin ?? NO_PAYLOAD }))}
          />
        </div>
        <div className="min-w-0 flex-1 basis-48">
          <RepresentationSelect
            id="message-representation" value={message.representation ?? ""} note={note} error={errorAt("/representation")}
            onChange={setRepresentation}
          />
        </div>
      </div>
      <PayloadPreview
        schema={payloadSchema.schema} loading={payloadSchema.loading} entity={entityOf(message.payload)} hasPayload={message.payload.entityId !== ""}
      />
      <OptionalPin id="headers" addLabel="Add headers" value={message.headers ?? null} error={errorAt("/headers")}>
        <PinField
          id="headers" label="Headers" optional entities={options.entityOptions} error={errorAt("/headers")}
          value={message.headers ?? null} onChange={(pin) => setOptionalPin("headers", pin)}
        />
      </OptionalPin>
      <OptionalPin id="key-pin" addLabel="Add message key" value={message.keyPin ?? null} error={errorAt("/keyPin")}>
        <PinField
          id="key-pin" label="Message key" optional entities={options.entityOptions} error={errorAt("/keyPin")}
          hint="Optional. The entity describing the record key, for example a Kafka key."
          value={message.keyPin ?? null} onChange={(pin) => setOptionalPin("keyPin", pin)}
        />
      </OptionalPin>
    </>
  );

  const channelsBody = (
    <>
      <CheckboxGroup
        id="message-channels" label="Sent on channels" checked={sentOn} onToggle={toggleChannel}
        options={doc.channels.map((c) => ({ value: c.key, label: channelLabel(c) }))}
        empty="No channels yet. Add a channel first, then choose it here."
        hint="Operations can only use a message on the channels that allow it."
      />
      {blocked && <Notice id="message-channels-blocked">{blocked}</Notice>}
    </>
  );

  const panes: PaneDef[] = [
    { id: "payload", title: "Payload", body: payloadBody },
    {
      id: "properties", title: messagePropertiesTitle(), count: message.traitKeys.length,
      body: (
        <MessagePropertiesCard
          draft={draft} options={options} message={message} index={index} problems={problems}
          onSectionChange={onSectionChange} onSelectItem={onSelectItem}
        />
      ),
    },
    { id: "details", title: "Details", count: setFieldCount(template, DETAILS_KEYS, formValue), body: cardForm(DETAILS_KEYS) },
    { id: "channels", title: "Sent on channels", count: sentOn.length, body: channelsBody },
    { id: "examples", title: "Examples", count: message.examples?.length ?? 0, body: cardForm(EXAMPLES_KEYS, exampleContext) },
    {
      id: "bindings", title: "Bindings", count: bindingCount(message.bindings),
      body: (
        <BindingsForm
          target="message" suggestedProtocol={carrier?.protocol} value={message.bindings ?? {}} idPrefix="message-bindings"
          errors={problems} errorPrefix={`${prefix}/bindings`} onChange={setBindings}
        />
      ),
    },
    { id: "docs", title: "Docs & tags", count: (message.tags?.length ?? 0) + (message.externalDocs ? 1 : 0), body: cardForm(DOCS_KEYS) },
    { id: "correlation", title: "Correlation id", count: message.correlationId ? 1 : 0, body: cardForm(CORRELATION_KEYS) },
    { id: "more", title: "More", count: setFieldCount(template, MORE_KEYS, formValue), body: cardForm(MORE_KEYS) },
  ].map((p) => ({ ...p, broken: errored.has(p.id) }));

  return (
    <div className="max-w-4xl space-y-space-4" data-testid="message-form">
      <div data-testid="message-sent-on" className="flex flex-wrap items-center gap-space-2 text-body-small">
        {sentOnChannels.length > 0 ? (
          <>
            <span className="text-muted-foreground">Sent on</span>
            {sentOnChannels.map((c) => (
              <button
                key={c.key} type="button" data-testid={`message-sent-on-chip-${c.key}`} onClick={() => pane.select("channels")}
                title="Change the channels this message is sent on"
                className="rounded-full border border-border bg-muted/40 px-space-2 py-0.5 text-caption text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {channelLabel(c)}
              </button>
            ))}
          </>
        ) : (
          <>
            <span className="text-muted-foreground">Not sent on any channel</span>
            <Button type="button" variant="link" size="sm" data-testid="message-sent-on-choose" onClick={() => pane.select("channels")} className="h-auto p-0">
              Choose channels
            </Button>
          </>
        )}
      </div>

      <div onBlur={(e) => { if (leftForm(e)) nameKeyFromContent(); }}>
        <PaneRail idPrefix="message-card" label="Message parts" panes={panes} active={pane.active} onSelect={pane.select} keepMounted={KEEP_MOUNTED} />
      </div>

      <IdentifierDisclosure
        id="message-key" value={message.key} error={errorAt("/key")}
        taken={allMessageKeys({ ...doc, messages: doc.messages.filter((_, i) => i !== index) })}
        onRename={(to) => renameAndSelect(draft, "message", message.key, to, onSelectItem)}
      />

      <div className="flex justify-end gap-space-2">
        <Button type="button" variant="outline" onClick={duplicate} data-testid="message-duplicate" aria-label="Duplicate message" className="gap-space-2 text-muted-foreground">
          <Copy className="size-4" /> Duplicate
        </Button>
        <Button type="button" variant="outline" onClick={remove} data-testid="message-remove" className="gap-space-2 text-muted-foreground hover:text-destructive">
          <Trash2 className="size-4" /> Remove message
        </Button>
      </div>
    </div>
  );
}
