// src/features/events/workspace/types.ts
import type { ChannelListItem, EventSpecListItem, Linked, MessageListItem, TraitListItem } from "@/lib/events/types";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";

/** Client-safe: shared by the server loaders and the workspace tab components. */

export type EventsCreateIntent = "eventSpec" | "message" | "channel";

export interface EventsTabData {
  eventSpecs: Linked<EventSpecListItem>[];
  messages: Linked<MessageListItem>[];
  channels: Linked<ChannelListItem>[];
  /** Entities a new Message may take as payload (every entity of the tenant). */
  payloadEntities: EntityOption[];
}

export interface TraitGroup {
  label: string;
  href: string;
  traits: Linked<TraitListItem>[];
}

export interface TraitsTabData {
  own: Linked<TraitListItem>[];
  /** Traits of broader levels (domain, Enterprise), read-only here. */
  inherited: TraitGroup[];
}

export const EMPTY_EVENTS_TAB: EventsTabData = { eventSpecs: [], messages: [], channels: [], payloadEntities: [] };
export const EMPTY_TRAITS_TAB: TraitsTabData = { own: [], inherited: [] };
