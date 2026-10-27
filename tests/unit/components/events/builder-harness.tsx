// Shared test harness for the event builder (B2). Not a test file (vitest only collects *.test.tsx): section tests import it.
//
//   const { probe } = renderSection(ServersSection, { doc });      // one section, backed by the real useEventDraft
//   const { probe } = renderBuilder({ doc, section: "servers" });   // the whole shell
//   probe.draft.doc / probe.draft.dirty / probe.section / probe.item   // always the latest committed values
import { useEffect, useState, type ComponentType } from "react";
import { render } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import { EventBuilder, type BuilderOptions, type SectionProps } from "@/features/events/builder/EventBuilder";
import type { BuilderSection } from "@/features/events/builder/sections";
import { useEventDraft, type DraftState, type SaveDocument } from "@/features/events/builder/use-event-draft";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { EventDetail } from "@/services/events/event.service";

export const PIN = { entityId: "ent-1", entityVersionId: "ver-1" };

/** A valid document: two servers, two channels, one message, one operation. */
export function sampleDocument(): EventDocument {
  return {
    ...emptyEventDocument("Orders", "Order events"),
    servers: [
      { key: "kafka-prod", protocol: "kafka", host: "prod.internal:9092" },
      { key: "kafka-dev", protocol: "kafka", host: "dev.internal:9092" },
    ],
    channels: [
      { key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] },
      { key: "refunds", address: "refunds.v1", protocol: "kafka", serverKeys: ["kafka-prod", "kafka-dev"], format: "avro", messageKeys: [] },
    ],
    messages: [{ key: "OrderCreated", payload: PIN, traitKeys: [] }],
    operations: [{ key: "publishOrder", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}

export const ENTITY_OPTIONS: EntityOption[] = [
  { id: "ent-1", name: "OrderCreated", ownerLabel: "Payments / Checkout", latestVersionId: "ver-1", latestVersionLabel: "1.0", href: "/schemas/payments/checkout/ordercreated" },
  { id: "ent-2", name: "OrderCancelled", ownerLabel: "Payments / Checkout", latestVersionId: "ver-2", latestVersionLabel: "1.0", href: "/schemas/payments/checkout/ordercancelled" },
];

export function makeEvent(document: EventDocument = sampleDocument(), id = "ev1"): EventDetail {
  return {
    id, name: "orders", specType: "asyncapi@3.0", document, latestVersionLabel: null, hasUnpublishedChanges: true,
    tenantId: "t1", domainId: "d1", productId: "p1",
  };
}

export interface Probe {
  draft: DraftState;
  section: BuilderSection;
  item: string | null;
  saveDocument: Mock<SaveDocument>;
}

interface HarnessOptions {
  doc?: EventDocument;
  options?: BuilderOptions;
  section?: BuilderSection;
  item?: string | null;
  /** Defaults to a save that succeeds and returns the event. */
  saveDocument?: Mock<SaveDocument>;
  onSaved?: (detail: EventDetail) => void;
  /** Passed to `EventBuilder` (false: the Design tab is hidden). Defaults to the builder's own default. */
  active?: boolean;
}

function useHarnessState(opts: HarnessOptions, saveDocument: Mock<SaveDocument>) {
  const [event] = useState(() => makeEvent(opts.doc));
  const draft = useEventDraft({ event, productId: "p1", saveDocument, onSaved: opts.onSaved });
  const [section, setSection] = useState<BuilderSection>(opts.section ?? "metadata");
  const [item, setItem] = useState<string | null>(opts.item ?? null);
  return { draft, section, setSection, item, setItem, options: opts.options ?? { entityOptions: ENTITY_OPTIONS, libraryTraits: [] } };
}

function newProbe(opts: HarnessOptions): Probe {
  const event = makeEvent(opts.doc);
  return {
    draft: undefined as unknown as DraftState,
    section: opts.section ?? "metadata",
    item: opts.item ?? null,
    saveDocument: opts.saveDocument ?? vi.fn<SaveDocument>().mockResolvedValue({ success: true, data: event }),
  };
}

export function renderSection(Section: ComponentType<SectionProps>, opts: HarnessOptions = {}) {
  const probe = newProbe(opts);
  function Host() {
    const h = useHarnessState(opts, probe.saveDocument);
    useEffect(() => { Object.assign(probe, { draft: h.draft, item: h.item }); });
    return <Section draft={h.draft} options={h.options} selectedItem={h.item} onSelectItem={h.setItem} />;
  }
  return { probe, ...render(<Host />) };
}

export function renderBuilder(opts: HarnessOptions = {}) {
  const probe = newProbe(opts);
  function Host() {
    const h = useHarnessState(opts, probe.saveDocument);
    useEffect(() => { Object.assign(probe, { draft: h.draft, section: h.section, item: h.item }); });
    return (
      <EventBuilder
        draft={h.draft} options={h.options} section={h.section} onSectionChange={h.setSection} item={h.item} onItemChange={h.setItem}
        active={opts.active}
      />
    );
  }
  return { probe, ...render(<Host />) };
}
