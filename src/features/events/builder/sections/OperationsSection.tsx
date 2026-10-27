"use client";

// src/features/events/builder/sections/OperationsSection.tsx
// Operations: send/receive, the channel, the messages (limited to that channel's messages) and an optional reply, drawn by hand
// because they can only offer valid combinations. The channel may be one of the event's own or an external channel reference, and a
// local channel may allow external messages (Channels); they are marked "(external)". Everything else the AsyncAPI operation object
// defines (title, summary, description, traits, security, tags, external docs, bindings) comes from the template form. The operations are a
// tab strip (`ItemTabs`) and the form under it a rail of panes (`PaneRail`), one showing at a time:
//   Basics (action, channel, messages) · Reply · Operation properties (Trait) · Details (title, summary, description) · Bindings · Docs & tags · Security
// A pane shows how many fields are set, keeps showing while switching operations, and shows by itself when it holds a problem. The key is generated: a placeholder until the user leaves the form, then named from the title or `${action}-${channel}`;
// the "Identifier" is the only place it shows. The parser's own problems still show under the field they belong to.
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { JsonObject, OperationAction } from "@/lib/event-specs/types";
import type { DocOperation, DocReplyAddress, DocumentProblem, EventDocument } from "@/lib/events/document/types";
import { TEMPLATES } from "@/lib/events/templates";
import { autoRenameKey, leftForm, newKey } from "../auto-key";
import { Field, selectClass } from "../controls";
import type { SectionProps } from "../EventBuilder";
import { IdentifierDisclosure } from "../Identifier";
import { externalItemLabel, operationMessagesEmpty, operationMessagesHint, operationPropertiesTitle, replyMessagesEmpty } from "../labels";
import { problemMessage, problemsByField, uniqueProblems } from "../problems";
import { buildReferenceContext } from "../references";
import { BindingsForm, TemplateForm, type TemplateFormContext } from "../template";
import type { DraftState } from "../use-event-draft";
import { allMessageKeys, CheckboxGroup, Notice, renameAndSelect } from "./ChannelsSection";
import { useFocusOnAdd } from "./focus-on-add";
import { ItemTabs } from "./ItemTabs";
import { PaneRail, usePaneState, type PaneDef, type PaneState } from "./PaneRail";
import { SectionHeading } from "./SectionHeading";
import { bindingCount, cardsWithProblems, cardTemplate, mergeValue, pickValue, setFieldCount } from "./form-cards";
import { OperationPropertiesCard } from "./OperationPropertiesCard";

const ACTIONS: Array<{ value: OperationAction; title: string; description: string }> = [
  { value: "send", title: "Send", description: "This service publishes" },
  { value: "receive", title: "Receive", description: "This service consumes" },
];
const ACTION_WORDS: Record<string, string> = { send: "Sends", receive: "Receives" };

/** The channel a new reply starts on: another channel when there is one (request/reply usually crosses channels), else this one. */
function defaultReplyChannel(channelKeys: string[], operationChannel: string): string | undefined {
  return channelKeys.find((k) => k !== operationChannel) ?? (channelKeys.includes(operationChannel) ? operationChannel : undefined);
}

/**
 * The operation properties `TemplateForm` draws. `channel`, `messages`, `action`, `reply` and `bindings` are drawn by hand (they must
 * offer valid combinations, or have a form of their own); the template's `traits` is stored as `traitKeys` and drawn by the Operation
 * properties card.
 */
const FORM_KEYS = ["title", "summary", "description", "security", "tags", "externalDocs"] as const;

/** The template fields each card draws. */
const DETAILS_KEYS = ["title", "summary", "description"] as const;
const DOCS_KEYS = ["tags", "externalDocs"] as const;
const SECURITY_KEYS = ["security"] as const;

/** Which part of the operation each card draws, for opening the card that holds a problem. */
const CARD_POINTERS: Record<string, readonly string[]> = {
  basics: ["action", "channelKey", "messageKeys"],
  reply: ["reply"],
  properties: ["traitKeys"],
  details: DETAILS_KEYS,
  bindings: ["bindings"],
  docs: DOCS_KEYS,
  security: SECURITY_KEYS,
};

/** The pane that shows on first sight, and the panes built up front (the others are built the first time they show; Reply also when the operation has one). */
const DEFAULT_PANE = "basics";
const KEEP_MOUNTED = ["basics", "properties", "details"] as const;

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

/** The channels an operation can be on: the document's own, then its external channel references (marked). */
const channelChoices = (doc: EventDocument): Array<{ key: string; label: string }> => [
  ...doc.channels.map((c) => ({ key: c.key, label: c.key })),
  ...doc.externalRefs.filter((r) => r.kind === "channel").map((r) => ({ key: r.key, label: externalItemLabel(r.key) })),
];

/** The channel is one another event owns (an external reference), and not shadowed by a local channel of the same key. */
const isExternalChannel = (doc: EventDocument, channelKey: string | undefined): boolean =>
  !doc.channels.some((c) => c.key === channelKey) && doc.externalRefs.some((r) => r.kind === "channel" && r.key === channelKey);

/**
 * The messages an operation on `channelKey` can use: the ones a local channel allows (an external message among them, once the channel
 * allows it); on an external channel every message of the document, because the parser cannot check them against a channel the event
 * does not own; none for a channel the document does not have.
 */
function messagesOf(doc: EventDocument, channelKey: string | undefined): string[] {
  const local = doc.channels.find((c) => c.key === channelKey);
  if (local) return local.messageKeys;
  return isExternalChannel(doc, channelKey) ? allMessageKeys(doc) : [];
}

/** A message in a checklist: an external reference is marked as such. */
const messageChoice = (doc: EventDocument) => (key: string) => ({
  value: key, label: doc.externalRefs.some((r) => r.kind === "message" && r.key === key) ? externalItemLabel(key) : key,
});

/** One sentence naming what a channel change took away. */
function droppedText(dropped: string[], channelKey: string): string {
  return `Removed ${dropped.length === 1 ? "a message" : `${dropped.length} messages`} that ${dropped.length === 1 ? "is" : "are"} not on channel "${channelKey}": ${dropped.join(", ")}.`;
}

export function OperationsSection({ draft, options, selectedItem, onSelectItem, onSectionChange }: SectionProps) {
  const { doc, update } = draft;
  const operations = doc.operations;
  const choices = channelChoices(doc);
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = uniqueProblems(draft.problems.concat(draft.serverProblems));

  const selected = selectedItem === null ? -1 : operations.findIndex((o) => o.key === selectedItem);
  const activeIndex = selected >= 0 ? selected : operations.length > 0 ? 0 : -1;
  const active = activeIndex >= 0 ? operations[activeIndex] : null;
  const needsChannel = choices.length === 0;
  const context = useMemo(() => buildReferenceContext(doc, { entityOptions: options.entityOptions }), [doc, options.entityOptions]);
  // Which pane shows lives here, not in the form: the form is rebuilt for every operation, the choice must survive.
  const errored = cardsWithProblems(problems, `/operations/${activeIndex}`, CARD_POINTERS);
  const pane = usePaneState(DEFAULT_PANE, errored);

  // The operation just added starts with the cursor in its action choice, on the Basics pane; moving to another operation ends that.
  const [addedKey, setAddedKey] = useState<string | null>(null);
  useFocusOnAdd(addedKey, active?.key ?? null, "operation-action-send");
  function addOperation() {
    if (needsChannel) return;
    const key = newKey(doc, "operation");
    const channelKey = choices[0].key;
    update((d) => ({ ...d, operations: [...d.operations, { key, action: "send", channelKey, messageKeys: [], traitKeys: [] }] }));
    setAddedKey(key);
    pane.select("basics");
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
      <SectionHeading section="operations" title="Operations">
        What this service does: publish messages to a channel or consume them from one.
      </SectionHeading>

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
        <div className="space-y-space-4">
          <ItemTabs
            label="Operations" prefix="operation" activeIndex={activeIndex} onSelect={(key) => { setAddedKey(null); onSelectItem(key); }}
            onAdd={needsChannel ? undefined : addOperation} addLabel="Add operation" addTestId="operation-add"
            items={operations.map((o, i) => ({
              key: o.key, subtitle: `${ACTION_WORDS[o.action] ?? "No action"} · ${o.channelKey || "no channel"}`,
              broken: problemsByField(problems, `/operations/${i}`).length > 0,
            }))}
          />
          <OperationForm
            key={activeIndex} draft={draft} options={options} index={activeIndex} operation={active} problems={problems} context={context}
            pane={pane} errored={errored} onSelectItem={onSelectItem} onSectionChange={onSectionChange}
          />
        </div>
      )}
    </section>
  );
}

function ChannelSelect({ id, label, value, choices, error, required, onChange }: {
  id: string; label: string; value: string; choices: Array<{ key: string; label: string }>; error?: string; required?: boolean; onChange: (next: string) => void;
}) {
  const known = choices.some((c) => c.key === value);
  return (
    <Field label={label} htmlFor={id} error={error}>
      <select id={id} data-testid={id} aria-required={required} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {value === "" && <option value="">Select a channel</option>}
        {value !== "" && !known && <option value={value}>{value} (not defined)</option>}
        {choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
    </Field>
  );
}

function OperationForm({ draft, options, index, operation, problems, context, pane, errored, onSelectItem, onSectionChange }: {
  draft: DraftState; options: SectionProps["options"]; index: number; operation: DocOperation; problems: DocumentProblem[]; context: TemplateFormContext;
  pane: PaneState; errored: ReadonlySet<string>; onSelectItem: (key: string | null) => void; onSectionChange?: SectionProps["onSectionChange"];
}) {
  const { doc, update } = draft;
  const channels = doc.channels;
  const choices = channelChoices(doc);
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
    const allowed = new Set(messagesOf(doc, next));
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
    // Switching the reply on or off happens in the Reply pane: keep it showing, so the user can try again.
    pane.select("reply");
    patch((o) => {
      const next = { ...o };
      if (!on) {
        delete next.reply;
        return next;
      }
      const channelKey = defaultReplyChannel(choices.map((c) => c.key), o.channelKey);
      next.reply = { ...(channelKey ? { channelKey } : {}), messageKeys: [] };
      return next;
    });
  }

  function changeReplyChannel(next: string) {
    const allowed = new Set(messagesOf(doc, next));
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

  const channelExists = choices.some((c) => c.key === operation.channelKey);
  const reply = operation.reply;
  const replyChannelExists = reply?.channelKey !== undefined && choices.some((c) => c.key === reply.channelKey);
  const actionError = errorAt("/action");
  const actionErrorId = "operation-action-error";
  const formValue = toFormValue(operation);

  /** A template form for the fields of one card: it sees only its own keys and its edits are merged back into the operation. */
  const cardForm = (keys: readonly string[]) => (
    <TemplateForm
      template={cardTemplate(TEMPLATES.operation, keys)} value={pickValue(formValue, keys)} idPrefix="operation" errors={problems}
      errorPrefix={`/operations/${index}`} context={context} compactHelp
      onChange={(next) => patch((o) => applyFormValue(o, mergeValue(toFormValue(o), keys, next)))}
    />
  );
  const basicsBody = (
    <>
      <fieldset id="operation-action" data-testid="operation-action" aria-describedby={actionError ? actionErrorId : undefined} className="space-y-space-2">
        <legend className="text-caption text-muted-foreground">Action</legend>
        <div className="grid gap-space-3 @md:grid-cols-2">
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
        id="operation-channel" label="Channel" required value={operation.channelKey} choices={choices}
        error={errorAt("/channelKey")} onChange={changeChannel}
      />
      {channelNotice && <Notice id="operation-channel-notice">{channelNotice}</Notice>}

      <CheckboxGroup
        id="operation-messages" label="Messages" checked={operation.messageKeys} onToggle={toggleMessage}
        options={messagesOf(doc, operation.channelKey).map(messageChoice(doc))}
        strayLabel="not on this channel" error={errorAt("/messageKeys")}
        empty={channelExists
          ? operationMessagesEmpty(operation.channelKey, isExternalChannel(doc, operation.channelKey))
          : "Choose a channel to see the messages it allows."}
        hint={operationMessagesHint(isExternalChannel(doc, operation.channelKey))}
      />
    </>
  );

  const replyBody = (
    <div data-testid="operation-reply" className="space-y-space-4">
      <>
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
              id="operation-reply-channel" label="Reply channel" value={reply.channelKey ?? ""} choices={choices}
              error={errorAt("/reply/channelKey")} onChange={changeReplyChannel}
            />
            {replyNotice && <Notice id="operation-reply-notice">{replyNotice}</Notice>}
            <CheckboxGroup
              id="operation-reply-messages" label="Reply messages" checked={reply.messageKeys ?? []} onToggle={toggleReplyMessage}
              options={messagesOf(doc, reply.channelKey).map(messageChoice(doc))}
              strayLabel="not on this channel" error={errorAt("/reply/messageKeys")}
              empty={replyChannelExists
                ? replyMessagesEmpty(reply.channelKey ?? "", isExternalChannel(doc, reply.channelKey))
                : "Choose a reply channel to see the messages it allows."}
            />
            <TemplateForm
              template={TEMPLATES.operationReplyAddress} value={{ ...reply.address }} idPrefix="operation-reply-address" errors={problems}
              errorPrefix={`/operations/${index}/reply/address`} onChange={changeReplyAddress} compactHelp
            />
          </div>
        )}
      </>
    </div>
  );

  const panes: PaneDef[] = [
    { id: "basics", title: "Basics", body: basicsBody },
    { id: "reply", title: "Reply", body: replyBody },
    {
      id: "properties", title: operationPropertiesTitle(), count: operation.traitKeys.length,
      body: (
          <OperationPropertiesCard
            draft={draft} options={options} operation={operation} index={index} problems={problems}
            onSectionChange={onSectionChange} onSelectItem={onSelectItem}
          />
      ),
    },
    { id: "details", title: "Details", count: setFieldCount(TEMPLATES.operation, DETAILS_KEYS, formValue), body: cardForm(DETAILS_KEYS) },
    {
      id: "bindings", title: "Bindings", count: bindingCount(operation.bindings),
      body: (
          <BindingsForm
            target="operation" suggestedProtocol={channels.find((c) => c.key === operation.channelKey)?.protocol} value={operation.bindings ?? {}}
            idPrefix="operation-bindings" errors={problems} errorPrefix={`/operations/${index}/bindings`} onChange={changeBindings}
          />
      ),
    },
    { id: "docs", title: "Docs & tags", count: (operation.tags?.length ?? 0) + (operation.externalDocs ? 1 : 0), body: cardForm(DOCS_KEYS) },
    { id: "security", title: "Security", count: operation.security?.length ?? 0, body: cardForm(SECURITY_KEYS) },
  ].map((p) => ({ ...p, broken: errored.has(p.id) }));

  return (
    <div className="max-w-4xl space-y-space-4" data-testid="operation-form">
      <div onBlur={(e) => { if (leftForm(e)) nameKeyFromContent(); }}>
        <PaneRail
          idPrefix="operation-card" label="Operation parts" panes={panes} active={pane.active} onSelect={pane.select}
          keepMounted={operation.reply !== undefined ? [...KEEP_MOUNTED, "reply"] : KEEP_MOUNTED}
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
