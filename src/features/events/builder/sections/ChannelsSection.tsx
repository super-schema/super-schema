"use client";

// src/features/events/builder/sections/ChannelsSection.tsx
// Channels: a list on the left and, on the right, two cards. "Where it lives" is the channel's address (with a card per {parameter}),
// its protocol, the servers it is on and its protocol bindings; "What it carries" is its documentation (the AsyncAPI channel template)
// and the messages it allows. The payload format is no longer asked: a channel follows its messages (round-2 R4) unless the user
// overrides it under Advanced. The key is generated: a placeholder until the user leaves the form, then named from the title or
// address; the "Identifier" below the form is the only place it shows. Every edit goes through `draft.update(fn)`.
// Under the list sits the card of EXTERNAL channels (channels another published event defines and this one uses): `ExternalRefsCard`.
//
// The pieces the Messages and Operations sections share live in ./graph-parts; the ones Operations imports from here are re-exported.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JsonObject, JsonSchemaDialect, PayloadFormat } from "@/lib/event-specs/types";
import type { DocChannel, DocChannelParameter, DocServer, DocumentProblem, EventDocument } from "@/lib/events/document/types";
import { JSON_SCHEMA_DIALECTS } from "@/lib/events/inputs";
import { TEMPLATES } from "@/lib/events/templates";
import { autoRenameKey, leftForm, newKey } from "../auto-key";
import { Field, ProtocolInput, selectClass } from "../controls";
import type { SectionProps } from "../EventBuilder";
import { IdentifierDisclosure } from "../Identifier";
import { externalItemLabel } from "../labels";
import { problemMessage, problemsByField, uniqueProblems } from "../problems";
import { buildReferenceContext } from "../references";
import { BindingsForm, TemplateForm, type TemplateFormContext } from "../template";
import type { DraftState } from "../use-event-draft";
import { ExternalRefsCard } from "./ExternalRefsCard";
import {
  aliasPointers, allChannelKeys, blockedText, channelLabel, CheckboxGroup, ItemList, messageLabel, Notice, plural, pointerSegment,
  renameAndSelect, setMessageAllowed, withoutChannel,
} from "./graph-parts";

export {
  allChannelKeys, allMessageKeys, blockedText, CheckboxGroup, ItemList, Notice, operationsUsingMessage, plural, renameAndSelect, setMessageAllowed,
} from "./graph-parts";
export type { CheckOption } from "./graph-parts";

const DEFAULT_PROTOCOL = "kafka";
const DEFAULT_DIALECT: JsonSchemaDialect = "draft-07";

/** The override select: "" is Auto, the others are the format written to `channel.format`. */
const FORMAT_CHOICES: Array<{ value: "" | PayloadFormat; label: string }> = [
  { value: "", label: "Auto (follow the messages)" },
  { value: "avro", label: "Avro" },
  { value: "json-schema", label: "JSON Schema" },
  { value: "protobuf", label: "Protobuf" },
];

// ── address parameters ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The distinct `{name}` expressions of an address, in order. Names are kept as typed: the parser looks them up as typed. */
export function addressParameterNames(address: string | null): string[] {
  const names: string[] = [];
  for (const m of (address ?? "").trim().matchAll(/\{([^{}]*)\}/g)) {
    if (m[1].trim() !== "" && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * `parameters` after the address changed from `before` to `after`: every name in the new address has a definition (existing ones
 * are kept, new ones start empty), definitions of names that just left the address are dropped, and definitions the address never
 * mentioned are left alone. `undefined` when nothing is left, so the document never stores an empty `parameters`.
 */
export function syncParameters(
  parameters: Record<string, JsonObject> | undefined, before: string | null, after: string | null,
): Record<string, JsonObject> | undefined {
  const was = new Set(addressParameterNames(before));
  const now = addressParameterNames(after);
  const kept = Object.entries(parameters ?? {}).filter(([name]) => now.includes(name) || !was.has(name));
  const have = new Set(kept.map(([name]) => name));
  const added = now.filter((name) => !have.has(name)).map((name): [string, JsonObject] => [name, {}]);
  const next = [...kept, ...added];
  return next.length > 0 ? Object.fromEntries(next) : undefined;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const definitionOf = (c: DocChannel, name: string): Record<string, unknown> =>
  (c.parameters && hasOwn(c.parameters, name) ? c.parameters[name] : {}) as Record<string, unknown>;

// ── the template form's view of a channel ───────────────────────────────────────────────────────────────────────────────

/** The properties of the AsyncAPI channel template, in the template's order. */
const TEMPLATE_KEYS = TEMPLATES.channel.fields.map((f) => f.key);
/** Everything of the template except `keep`: what a form that draws only some of the properties must not draw. */
const hideAllBut = (...keep: string[]) => TEMPLATE_KEYS.filter((k) => !keep.includes(k));

const ADDRESS_FIELDS_HIDDEN = hideAllBut("address");
const SERVER_FIELDS_HIDDEN = hideAllBut("servers");
/** The "What it carries" form: title, summary, description, tags, external docs. The rest is drawn by hand. */
const DETAIL_FIELDS_HIDDEN = ["address", "servers", "parameters", "messages", "bindings"];
/** Template properties stored under the same name on the document's channel. */
const DETAIL_KEYS = ["title", "summary", "description", "tags", "externalDocs"] as const;

/** The channel as the template form sees it: AsyncAPI property names (`servers`, not `serverKeys`), only what is set. */
function toFormValue(c: DocChannel): Record<string, unknown> {
  const source = c as unknown as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  if (c.address) value.address = c.address;
  for (const k of DETAIL_KEYS) if (k in source) value[k] = source[k];
  if (c.serverKeys.length > 0) value.servers = c.serverKeys;
  return value;
}

/**
 * The protocol after the servers changed. It follows the FIRST selected server, but only while it is still "default": empty, kafka,
 * what a brand-new channel starts with, or the protocol of the server it was last taken from. A protocol the user typed stays.
 */
function protocolAfterServers(c: DocChannel, nextKeys: string[], servers: DocServer[]): string {
  const protocolOf = (key: string | undefined): string => servers.find((s) => s.key === key)?.protocol.trim() ?? "";
  const first = protocolOf(nextKeys[0]);
  if (first === "" || nextKeys[0] === c.serverKeys[0]) return c.protocol;
  const follows = c.protocol.trim() === "" || c.protocol === DEFAULT_PROTOCOL || c.protocol === servers[0]?.protocol || c.protocol === protocolOf(c.serverKeys[0]);
  return follows ? first : c.protocol;
}

/** The channel with the form's next value applied; the properties the form does not draw (key, protocol, format, bindings, …) are untouched. */
function applyForm(c: DocChannel, next: Record<string, unknown>, servers: DocServer[]): DocChannel {
  const out: Record<string, unknown> = { ...c };
  for (const k of DETAIL_KEYS) delete out[k];
  for (const k of DETAIL_KEYS) if (k in next) out[k] = next[k];

  const address = typeof next.address === "string" && next.address !== "" ? next.address : null;
  out.address = address;
  if (address !== c.address) {
    const parameters = syncParameters(c.parameters, c.address, address);
    if (parameters) out.parameters = parameters;
    else delete out.parameters;
  }

  const serverKeys = Array.isArray(next.servers) ? next.servers.filter((k): k is string => typeof k === "string") : [];
  out.serverKeys = serverKeys;
  out.protocol = protocolAfterServers(c, serverKeys, servers);
  return out as unknown as DocChannel;
}

// ── section ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ChannelsSection({ draft, options, selectedItem, onSelectItem }: SectionProps) {
  const { doc, update } = draft;
  const channels = doc.channels;
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = useMemo(() => uniqueProblems(draft.problems.concat(draft.serverProblems)), [draft.problems, draft.serverProblems]);
  const context = useMemo(() => buildReferenceContext(doc, { entityOptions: options.entityOptions }), [doc, options.entityOptions]);

  const selected = selectedItem === null ? -1 : channels.findIndex((c) => c.key === selectedItem);
  const activeIndex = selected >= 0 ? selected : channels.length > 0 ? 0 : -1;
  const active = activeIndex >= 0 ? channels[activeIndex] : null;

  function addChannel() {
    // A placeholder key, named from the title or address once the user leaves the form. The protocol follows the first server.
    const key = newKey(doc, "channel");
    const protocol = doc.servers[0]?.protocol || DEFAULT_PROTOCOL;
    update((d) => ({ ...d, channels: [...d.channels, { key, address: null, protocol, serverKeys: [], messageKeys: [] }] }));
    onSelectItem(key);
  }

  return (
    <section aria-labelledby="channels-heading" data-testid="section-channels" className="space-y-space-6">
      <header className="flex items-start justify-between gap-space-4">
        <div className="space-y-space-1">
          <h2 id="channels-heading" className="text-heading-3 text-foreground">Channels</h2>
          <p className="text-body-small text-muted-foreground">Topics and queues. Each one says where it lives and which messages it carries.</p>
        </div>
        {channels.length > 0 && (
          <Button type="button" size="sm" variant="outline" onClick={addChannel} data-testid="channel-add" className="gap-space-2">
            <Plus className="size-4" /> Add channel
          </Button>
        )}
      </header>

      {!active ? (
        <div data-testid="channel-empty" className="space-y-space-3 rounded-lg border border-dashed border-border p-space-6 text-center">
          <p className="text-heading-3 text-foreground">No channels yet</p>
          <p className="text-body-small text-muted-foreground">A channel is a topic or queue that messages travel on. Operations send and receive on channels.</p>
          <Button type="button" onClick={addChannel} data-testid="channel-empty-add" className="gap-space-2"><Plus className="size-4" /> Add channel</Button>
        </div>
      ) : (
        <div className="grid gap-space-6 md:grid-cols-[14rem_1fr]">
          <ItemList
            label="Channels" prefix="channel" activeIndex={activeIndex} onSelect={onSelectItem}
            items={channels.map((c, i) => ({
              key: c.key, label: channelLabel(c), subtitle: c.protocol, broken: problemsByField(problems, `/channels/${i}`).length > 0,
            }))}
          />
          <ChannelForm
            key={activeIndex} draft={draft} index={activeIndex} channel={active} problems={problems} context={context} onSelectItem={onSelectItem}
          />
        </div>
      )}

      <ExternalRefsCard kind="channel" draft={draft} problems={problems} />
    </section>
  );
}

function ChannelForm({ draft, index, channel, problems, context, onSelectItem }: {
  draft: DraftState; index: number; channel: DocChannel; problems: DocumentProblem[];
  context: TemplateFormContext; onSelectItem: (key: string | null) => void;
}) {
  const { doc, update } = draft;
  const [blocked, setBlocked] = useState<string | null>(null);
  const prefix = `/channels/${index}`;
  const errorAt = (suffix: string) => problemMessage(problemsByField(problems, `${prefix}${suffix}`));
  // The document stores `serverKeys` / `messageKeys`; the template form shows problems under the AsyncAPI names.
  const formProblems = useMemo(() => aliasPointers(problems, prefix, { serverKeys: "servers", messageKeys: "messages" }), [problems, prefix]);

  const formatProblem = errorAt("/format");
  const dialectProblem = errorAt("/formatDialect");
  // Open from the start when the channel already overrides the format; it stays open while the user works in it (choosing Auto
  // must not close the select), and a problem found in it opens it.
  const [advancedOpen, setAdvancedOpen] = useState(channel.format !== undefined);
  const advancedShown = advancedOpen || Boolean(formatProblem || dialectProblem);

  function patch(change: (c: DocChannel, d: EventDocument) => DocChannel) {
    update((d) => ({ ...d, channels: d.channels.map((c, i) => (i === index ? change(c, d) : c)) }));
  }

  /** Once the user leaves the form: a placeholder key becomes a name from the title or address. Later edits never rename it again. */
  function nameKeyFromContent() {
    const from = channel.key;
    const values = (d: EventDocument) => {
      const c = d.channels.find((x) => x.key === from);
      return { title: c?.title, address: c?.address };
    };
    const preview = autoRenameKey(doc, "channel", from, values(doc));
    if (preview === doc) return;
    update((d) => autoRenameKey(d, "channel", from, values(d)));
    onSelectItem(preview.channels[index].key);
  }

  function setParameter(name: string, next: Record<string, unknown>) {
    patch((c) => ({ ...c, parameters: { ...(c.parameters ?? {}), [name]: next as DocChannelParameter } }));
  }

  function setFormat(value: string) {
    patch((c) => {
      const next: DocChannel = { ...c };
      if (value === "") {
        delete next.format;
        delete next.formatDialect;
        return next;
      }
      next.format = value as PayloadFormat;
      if (value === "json-schema") next.formatDialect = c.formatDialect ?? DEFAULT_DIALECT;
      else delete next.formatDialect;
      return next;
    });
  }

  function setBindings(next: Record<string, unknown>) {
    patch((c) => {
      if (Object.keys(next).length === 0) {
        const copy = { ...c };
        delete copy.bindings;
        return copy;
      }
      return { ...c, bindings: next as JsonObject };
    });
  }

  function toggleMessage(messageKey: string, on: boolean) {
    const result = setMessageAllowed(doc, channel.key, messageKey, on);
    if ("blockedBy" in result) {
      setBlocked(blockedText(messageKey, channel.key, result.blockedBy));
      return;
    }
    setBlocked(null);
    update((d) => {
      const next = setMessageAllowed(d, channel.key, messageKey, on);
      return "doc" in next ? next.doc : d;
    });
  }

  function remove() {
    const key = channel.key;
    const onIt = doc.operations.filter((o) => o.channelKey === key);
    const replyingOnIt = doc.operations.filter((o) => o.channelKey !== key && o.reply?.channelKey === key);
    if (onIt.length + replyingOnIt.length > 0) {
      const consequences = [
        onIt.length > 0 ? `delete ${plural(onIt.length, "operation")} (${onIt.map((o) => o.key).join(", ")})` : null,
        replyingOnIt.length > 0 ? `remove the reply of ${plural(replyingOnIt.length, "operation")} (${replyingOnIt.map((o) => o.key).join(", ")})` : null,
      ].filter(Boolean).join(" and ");
      if (!window.confirm(`Channel "${key}" is used by operations. Removing it will ${consequences}. Remove it?`)) return;
    }
    update((d) => {
      const channelsLeft = d.channels.filter((_, i) => i !== index);
      const stillDefined = channelsLeft.some((c) => c.key === key) || d.externalRefs.some((r) => r.kind === "channel" && r.key === key);
      return stillDefined ? { ...d, channels: channelsLeft } : withoutChannel({ ...d, channels: channelsLeft }, key);
    });
    onSelectItem(null);
  }

  const formValue = toFormValue(channel);
  const onForm = (next: Record<string, unknown>) => patch((c, d) => applyForm(c, next, d.servers));
  const parameterNames = addressParameterNames(channel.address);
  const parameterError = problemMessage(problems.filter((p) => p.pointer === `${prefix}/parameters`));
  const dialect = channel.formatDialect ?? DEFAULT_DIALECT;

  return (
    <div className="max-w-2xl space-y-space-4" data-testid="channel-form">
      <div onBlur={(e) => { if (leftForm(e)) nameKeyFromContent(); }} className="space-y-space-6">
        <section aria-labelledby="channel-lives-heading" className="space-y-space-4 rounded-lg border border-border p-space-4">
          <h3 id="channel-lives-heading" className="text-body font-medium text-foreground">Where it lives</h3>
          <TemplateForm
            template={TEMPLATES.channel} value={formValue} idPrefix="channel" errors={formProblems} errorPrefix={prefix}
            context={context} hideKeys={ADDRESS_FIELDS_HIDDEN} onChange={onForm}
          />
          {parameterNames.length > 0 && (
            <div data-testid="channel-parameters" className="space-y-space-3 rounded-md bg-muted/40 p-space-3">
              <p className="text-caption text-muted-foreground">Parameters: one for each {"{name}"} in the address.</p>
              {parameterNames.map((name, i) => (
                <fieldset key={name} data-testid={`channel-parameter-${i}`} className="space-y-space-3 rounded-md border border-border bg-background p-space-3">
                  <legend className="px-space-1 text-caption text-muted-foreground">{`Parameter "${name}"`}</legend>
                  <TemplateForm
                    template={TEMPLATES.channelParameter} value={definitionOf(channel, name)} idPrefix={`channel-parameter-${i}`}
                    errors={problems} errorPrefix={`${prefix}/parameters/${pointerSegment(name)}`}
                    onChange={(next) => setParameter(name, next)}
                  />
                </fieldset>
              ))}
              {parameterError && <p id="channel-parameters-error" data-testid="channel-parameters-error" className="text-body-small text-destructive">{parameterError}</p>}
            </div>
          )}
          <Field
            label="Protocol" htmlFor="channel-protocol" error={errorAt("/protocol")}
            hint="Follows the first server you choose below, until you type another."
          >
            <ProtocolInput id="channel-protocol" aria-required value={channel.protocol} onChange={(protocol) => patch((c) => ({ ...c, protocol }))} />
          </Field>
          <TemplateForm
            template={TEMPLATES.channel} value={formValue} idPrefix="channel" errors={formProblems} errorPrefix={prefix}
            context={context} hideKeys={SERVER_FIELDS_HIDDEN} onChange={onForm}
          />
          <BindingsForm
            target="channel" suggestedProtocol={channel.protocol} value={channel.bindings ?? {}} idPrefix="channel-bindings"
            errors={problems} errorPrefix={`${prefix}/bindings`} onChange={setBindings}
          />
        </section>

        <section aria-labelledby="channel-carries-heading" className="space-y-space-4 rounded-lg border border-border p-space-4">
          <h3 id="channel-carries-heading" className="text-body font-medium text-foreground">What it carries</h3>
          <TemplateForm
            template={TEMPLATES.channel} value={formValue} idPrefix="channel" errors={formProblems} errorPrefix={prefix}
            context={context} hideKeys={DETAIL_FIELDS_HIDDEN} onChange={onForm}
          />
          <CheckboxGroup
            id="channel-messages" label="Allowed messages" checked={channel.messageKeys} onToggle={toggleMessage} error={errorAt("/messageKeys")}
            options={[
              ...doc.messages.map((m) => ({ value: m.key, label: messageLabel(m) })),
              // An operation can only use an external message on a channel that allows it.
              ...doc.externalRefs.filter((r) => r.kind === "message").map((r) => ({ value: r.key, label: externalItemLabel(r.key) })),
            ]}
            empty="No messages yet. Add one in Messages, then allow it here."
            hint="Operations on this channel can only use these messages."
          />
          {blocked && <Notice id="channel-messages-blocked">{blocked}</Notice>}

          <div className="space-y-space-3">
            <button
              type="button" id="channel-advanced-toggle" data-testid="channel-advanced-toggle" aria-expanded={advancedShown} aria-controls="channel-advanced"
              onClick={() => setAdvancedOpen(!advancedShown)}
              className="inline-flex items-center gap-space-1 rounded-md text-body-small font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {advancedShown ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}
              Advanced
            </button>
            {advancedShown && (
              <div id="channel-advanced" data-testid="channel-advanced" role="group" aria-labelledby="channel-advanced-toggle" className="space-y-space-3 border-l-2 border-border pl-space-3">
                <Field
                  label="Override the payload format for every message on this channel" htmlFor="channel-format-override" error={formatProblem}
                  hint="Leave on Auto: each message then uses its own representation. Choose a format only to force all of this channel's messages into it."
                >
                  <select
                    id="channel-format-override" data-testid="channel-format-override" className={selectClass} value={channel.format ?? ""}
                    onChange={(e) => setFormat(e.target.value)}
                  >
                    {FORMAT_CHOICES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </Field>
                {channel.format === "json-schema" && (
                  <Field label="JSON Schema dialect" htmlFor="channel-dialect" error={dialectProblem}>
                    <select
                      id="channel-dialect" data-testid="channel-dialect" className={selectClass} value={dialect}
                      onChange={(e) => patch((c) => ({ ...c, formatDialect: e.target.value as JsonSchemaDialect }))}
                    >
                      {JSON_SCHEMA_DIALECTS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </Field>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      <IdentifierDisclosure
        id="channel-key" value={channel.key} error={errorAt("/key")}
        taken={allChannelKeys({ ...doc, channels: doc.channels.filter((_, i) => i !== index) })}
        onRename={(to) => renameAndSelect(draft, "channel", channel.key, to, onSelectItem)}
      />

      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={remove} data-testid="channel-remove" className="gap-space-2 text-muted-foreground hover:text-destructive">
          <Trash2 className="size-4" /> Remove channel
        </Button>
      </div>
    </div>
  );
}
