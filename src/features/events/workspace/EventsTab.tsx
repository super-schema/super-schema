"use client";

import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCode2, Mail, Plus, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createChannelAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions";
import { createEventSpecAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions";
import { createMessageAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { JSON_SCHEMA_DIALECTS, KNOWN_PROTOCOLS, PAYLOAD_FORMATS } from "@/lib/events/inputs";
import { assetHref, EVENT_SEGMENT, type EventsSection } from "@/lib/navigation/asset-href";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { Field, FormShell, selectClass, useCreateForm } from "./create-form";
import type { EventsCreateIntent, EventsTabData } from "./types";

const SECTIONS: Array<{ id: EventsSection; label: string; singular: string; intent: EventsCreateIntent; icon: typeof Mail }> = [
  { id: EVENT_SEGMENT.eventSpec, label: "Event Specs", singular: "Event Spec", intent: "eventSpec", icon: FileCode2 },
  { id: EVENT_SEGMENT.message, label: "Messages", singular: "Message", intent: "message", icon: Mail },
  { id: EVENT_SEGMENT.channel, label: "Channels", singular: "Channel", intent: "channel", icon: Radio },
];
const SECTION_OF: Record<EventsCreateIntent, EventsSection> = {
  eventSpec: EVENT_SEGMENT.eventSpec,
  message: EVENT_SEGMENT.message,
  channel: EVENT_SEGMENT.channel,
};

const tabDomId = (id: EventsSection) => `events-tab-${id}`;
const PANEL_DOM_ID = "events-tabpanel";

type CreateFormProps = { productId: string; onCancel: () => void; onCreated: (id: string) => void };

function NewEventSpecForm({ productId, onCancel, onCreated }: CreateFormProps) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const form = useCreateForm(onCreated);
  return (
    <FormShell title="New Event Spec" testId="new-event-spec-form" error={form.error} busy={form.busy} onCancel={onCancel}
      onSubmit={() => form.run(() => createEventSpecAction(productId, { name, title: title.trim() || undefined }))}>
      <Field label="Name (AsyncAPI-safe: letters, digits, . _ -)" htmlFor="new-spec-name">
        <Input id="new-spec-name" aria-label="Event spec name" value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout-service" required />
      </Field>
      <Field label="Title (info.title — defaults to the name)" htmlFor="new-spec-title">
        <Input id="new-spec-title" aria-label="Event spec title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
    </FormShell>
  );
}

function NewMessageForm({ productId, entities, onCancel, onCreated }: CreateFormProps & { entities: EntityOption[] }) {
  const [name, setName] = useState("");
  const [entityId, setEntityId] = useState("");
  const form = useCreateForm(onCreated);
  const groups = useMemo(() => {
    const byOwner = new Map<string, EntityOption[]>();
    for (const e of entities) byOwner.set(e.ownerLabel, [...(byOwner.get(e.ownerLabel) ?? []), e]);
    return [...byOwner.entries()];
  }, [entities]);
  return (
    <FormShell title="New Message" testId="new-message-form" error={form.error} busy={form.busy} onCancel={onCancel}
      onSubmit={() => form.run(() => createMessageAction(productId, { name, payload: { entityId } }))}>
      <Field label="Name" htmlFor="new-message-name">
        <Input id="new-message-name" aria-label="Message name" value={name} onChange={(e) => setName(e.target.value)} placeholder="OrderCreated" required />
      </Field>
      <Field label="Payload entity (pins its latest published version)" htmlFor="new-message-payload">
        <select id="new-message-payload" aria-label="Payload entity" className={selectClass} value={entityId} onChange={(e) => setEntityId(e.target.value)} required>
          <option value="">Select an entity</option>
          {groups.map(([owner, items]) => (
            <optgroup key={owner} label={owner}>
              {items.map((e) => (
                <option key={e.id} value={e.id}>{e.name}{e.latestVersionLabel ? ` (v${e.latestVersionLabel})` : " (unpublished)"}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
    </FormShell>
  );
}

function NewChannelForm({ productId, onCancel, onCreated }: CreateFormProps) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [protocol, setProtocol] = useState("kafka");
  const [format, setFormat] = useState("avro");
  const [dialect, setDialect] = useState("draft-07");
  const form = useCreateForm(onCreated);
  return (
    <FormShell title="New Channel" testId="new-channel-form" error={form.error} busy={form.busy} onCancel={onCancel}
      onSubmit={() =>
        form.run(() =>
          createChannelAction(productId, { name, address: address.trim() || null, protocol, format, formatDialect: format === "json-schema" ? dialect : null })
        )
      }>
      <div className="grid grid-cols-1 gap-space-3 md:grid-cols-2">
        <Field label="Name" htmlFor="new-channel-name">
          <Input id="new-channel-name" aria-label="Channel name" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders" required />
        </Field>
        <Field label="Address (topic / queue; {param} allowed)" htmlFor="new-channel-address">
          <Input id="new-channel-address" aria-label="Address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="payments.orders.v1" />
        </Field>
        <Field label="Protocol" htmlFor="new-channel-protocol">
          <Input id="new-channel-protocol" aria-label="Protocol" list="event-protocols" value={protocol} onChange={(e) => setProtocol(e.target.value)} />
          <datalist id="event-protocols">{KNOWN_PROTOCOLS.map((p) => <option key={p} value={p} />)}</datalist>
        </Field>
        <Field label="Format" htmlFor="new-channel-format">
          <select id="new-channel-format" aria-label="Format" className={selectClass} value={format} onChange={(e) => setFormat(e.target.value)}>
            {PAYLOAD_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Field>
        {format === "json-schema" && (
          <Field label="JSON Schema dialect" htmlFor="new-channel-dialect">
            <select id="new-channel-dialect" aria-label="Dialect" className={selectClass} value={dialect} onChange={(e) => setDialect(e.target.value)}>
              {JSON_SCHEMA_DIALECTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        )}
      </div>
    </FormShell>
  );
}

function ItemList<T extends { id: string; name: string; summary: string; href: string }>({
  items, empty, testId, meta,
}: { items: T[]; empty: string; testId: string; meta: (item: T) => ReactNode }) {
  if (items.length === 0) return <p className="py-space-8 text-center text-body-small text-muted-foreground" data-testid={`${testId}-empty`}>{empty}</p>;
  return (
    <ul className="grid grid-cols-1 gap-space-3 md:grid-cols-2 xl:grid-cols-3" data-testid={testId}>
      {items.map((item) => (
        <li key={item.id}>
          <Link href={item.href} className="block rounded-lg border border-border/60 p-space-4 transition-colors hover:border-primary/40">
            <div className="flex items-center justify-between gap-space-2">
              <span className="truncate font-medium text-foreground">{item.name}</span>
              <span className="flex shrink-0 items-center gap-space-1">{meta(item)}</span>
            </div>
            {item.summary && <p className="mt-space-1 line-clamp-2 text-caption text-muted-foreground">{item.summary}</p>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const versionBadges = (latest: string | null, dirty: boolean) => (
  <>
    <Badge variant="secondary">{latest ? `v${latest}` : "unpublished"}</Badge>
    {latest && dirty && <Badge variant="outline">unpublished changes</Badge>}
  </>
);

export function EventsTab({
  productId, domainSlug, productSlug, data, section, onSectionChange, createIntent, onCreateIntentConsumed,
}: {
  productId: string;
  domainSlug: string;
  productSlug: string;
  data: EventsTabData;
  section: EventsSection;
  onSectionChange: (section: EventsSection) => void;
  createIntent?: EventsCreateIntent | null;
  onCreateIntentConsumed?: () => void;
}) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [creating, setCreating] = useState<EventsCreateIntent | null>(null);

  // A New-menu click on the workspace header opens the matching inline form (same idea as DomainTypesTab).
  // The form opens in the render pass that first sees the intent; the parent is told afterwards, in the
  // effect: switch to that section and clear the intent so the same menu item works again.
  const [seenIntent, setSeenIntent] = useState<EventsCreateIntent | null>(null);
  if ((createIntent ?? null) !== seenIntent) {
    setSeenIntent(createIntent ?? null);
    if (createIntent) setCreating(createIntent);
  }
  useEffect(() => {
    if (!createIntent) return;
    onSectionChange(SECTION_OF[createIntent]);
    onCreateIntentConsumed?.();
  }, [createIntent, onCreateIntentConsumed, onSectionChange]);

  const at = { domainSlug, productSlug };
  const opened = (href: string) => {
    void invalidateDomainsTree();
    router.push(href);
  };
  const counts: Record<EventsSection, number> = {
    [EVENT_SEGMENT.eventSpec]: data.eventSpecs.length,
    [EVENT_SEGMENT.message]: data.messages.length,
    [EVENT_SEGMENT.channel]: data.channels.length,
  };
  const currentIndex = Math.max(0, SECTIONS.findIndex((s) => s.id === section));
  const current = SECTIONS[currentIndex];

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % SECTIONS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SECTIONS.length - 1;
    else return;
    event.preventDefault();
    onSectionChange(SECTIONS[next].id);
    document.getElementById(tabDomId(SECTIONS[next].id))?.focus();
  }

  return (
    <div className="space-y-space-4" data-testid="events-tab">
      <div className="flex flex-wrap items-center gap-space-2">
        <div role="tablist" aria-label="Events sections" className="flex items-center gap-space-1 rounded-lg bg-muted p-[3px]">
          {SECTIONS.map((s, index) => (
            <button
              key={s.id}
              id={tabDomId(s.id)}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              aria-controls={PANEL_DOM_ID}
              tabIndex={section === s.id ? 0 : -1}
              data-testid={`events-section-${s.id}`}
              onClick={() => onSectionChange(s.id)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              className={`flex items-center gap-space-1 rounded-md px-space-3 py-1 text-body-small ${section === s.id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <s.icon className="w-4 h-4" aria-hidden="true" />
              {s.label}
              <span className="text-caption text-muted-foreground">{counts[s.id]}</span>
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => setCreating(current.intent)} data-testid="events-new">
          <Plus className="w-4 h-4" /> New {current.singular}
        </Button>
      </div>

      {creating === "eventSpec" && (
        <NewEventSpecForm productId={productId} onCancel={() => setCreating(null)} onCreated={(id) => opened(assetHref({ kind: "eventSpec", id, ...at }))} />
      )}
      {creating === "message" && (
        <NewMessageForm productId={productId} entities={data.payloadEntities} onCancel={() => setCreating(null)} onCreated={(id) => opened(assetHref({ kind: "message", id, ...at }))} />
      )}
      {creating === "channel" && (
        <NewChannelForm productId={productId} onCancel={() => setCreating(null)} onCreated={(id) => opened(assetHref({ kind: "channel", id, ...at }))} />
      )}

      <div role="tabpanel" id={PANEL_DOM_ID} aria-labelledby={tabDomId(current.id)}>
        {section === EVENT_SEGMENT.eventSpec && (
          <ItemList items={data.eventSpecs} empty="No event specs yet — create one to describe what this product sends and receives." testId="events-specs"
            meta={(s) => (<>{versionBadges(s.latestVersionLabel, s.hasUnpublishedChanges)}<span className="text-caption text-muted-foreground">{s.operationCount} op</span></>)} />
        )}
        {section === EVENT_SEGMENT.message && (
          <ItemList items={data.messages} empty="No messages yet — a message pins a published entity version as its payload." testId="events-messages"
            meta={(m) => (<>{versionBadges(m.latestVersionLabel, m.hasUnpublishedChanges)}<span className="text-caption text-muted-foreground">{m.payloadEntityName}</span></>)} />
        )}
        {section === EVENT_SEGMENT.channel && (
          <ItemList items={data.channels} empty="No channels yet — a channel is a topic / queue with a format profile." testId="events-channels"
            meta={(c) => (<><Badge variant="secondary">{c.protocol}</Badge><Badge variant="outline">{c.format}</Badge></>)} />
        )}
      </div>
    </div>
  );
}
