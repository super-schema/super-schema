// src/features/events/builder/labels.ts
// The user-facing wording of the event builder, in one place: the names of "traits" and the copy of external references. AsyncAPI calls
// traits traits; users do not understand that word, so the UI says "Message properties" and keeps "(Trait)" in brackets as the technical
// secondary text. Change a name here and it changes everywhere (the builder section, the Enterprise / Domain tab and sidebar leaf, the
// create menu, page titles, empty states, tooltips). The external-reference section further down holds the card, picker and operation
// copy for channels and messages that another event published.
// Internal names (section id `traits`, URL `?tab=traits`, test ids `trait-*`) are NOT user-facing and stay as they are. Pure, client-safe.
import type { TraitKind } from "@/lib/event-specs/types";
import type { ExternalItemKind } from "@/lib/events/external-refs";

export const MESSAGE_PROPERTIES = "Message properties";
export const OPERATION_PROPERTIES = "Operation properties";
export const TRAIT_SUFFIX = "(Trait)";
/** The small badge next to a property set. */
export const TRAIT_BADGE = "Trait";
export const BUILT_IN_BADGE = "Built in";
export const LIBRARY_BADGE = "Library";

/** "Message properties (Trait)". */
export const messagePropertiesTitle = (): string => `${MESSAGE_PROPERTIES} ${TRAIT_SUFFIX}`;
/** "Operation properties (Trait)". */
export const operationPropertiesTitle = (): string => `${OPERATION_PROPERTIES} ${TRAIT_SUFFIX}`;
/** The heading of the properties of `kind`, with the bracketed secondary text. */
export const propertiesTitle = (kind: TraitKind): string => (kind === "MESSAGE" ? messagePropertiesTitle() : operationPropertiesTitle());
/** The plain name of the properties of `kind`: "Message properties" / "Operation properties". */
export const propertiesName = (kind: TraitKind): string => (kind === "MESSAGE" ? MESSAGE_PROPERTIES : OPERATION_PROPERTIES);
/** Lower case, for the middle of a sentence: "message properties". */
export const propertiesNameLower = (kind: TraitKind): string => propertiesName(kind).toLowerCase();

/** The label of the add button of one kind: "Add message properties". */
export const addPropertiesLabel = (kind: TraitKind): string => `Add ${propertiesNameLower(kind)}`;
/** What a blank, not yet named set is called: "New message properties". */
export const newPropertiesLabel = (kind: TraitKind): string => `New ${propertiesNameLower(kind)}`;

/** The entry of the create menu at the Enterprise / Domain level, and its description. */
export const NEW_PROPERTIES_MENU = "New Message Properties";
export const NEW_PROPERTIES_DESCRIPTION = "Reusable message properties (Trait)";

/** The Enterprise / Domain tab label and the sidebar leaf. */
export const PROPERTIES_TAB_LABEL = MESSAGE_PROPERTIES;
/** The breadcrumb / page subtitle of the library pages. */
export const PROPERTIES_PAGE_SUBTITLE = messagePropertiesTitle();

export const GROUP_ON_MESSAGES = "On messages";
export const GROUP_ON_OPERATIONS = "On operations";
/** The list group heading of `kind`. */
export const groupLabel = (kind: TraitKind): string => (kind === "MESSAGE" ? GROUP_ON_MESSAGES : GROUP_ON_OPERATIONS);

export const BUILT_IN_NOTE = "Built in — can't be modified";
export const LIBRARY_NOTE = "From the library — edit it under Message properties at the Tenant/Domain level";

/** "1 property" / "8 properties". */
export const propertyCountText = (count: number): string => `${count} ${count === 1 ? "property" : "properties"}`;
/** "CloudEvents 1.0 — 8 properties": how a chooser item shows what it brings. */
export const chooserItemText = (name: string, count: number | null): string => (count === null ? name : `${name} — ${propertyCountText(count)}`);

/** The explanation shown where a built-in set is opened. */
export const builtInExplanation = (name: string): string => `${name} is built in: its properties are defined by a specification, so it cannot be changed or deleted. Apply it to a message as it is.`;

// ── External references: channels and messages another event published, used here ──────────────────────────────────────────
// "External" is the word users see; the document calls them `externalRefs`.

export const EXTERNAL_BADGE = "External";
/** The mark after an external reference's key in a pick list or a checklist: the ONE definition (`references.ts` builds its options with `externalItemLabel` too). */
export const EXTERNAL_SUFFIX = "(external)";
/** "Order-placed (external)": how a pick list names an external reference. */
export const externalItemLabel = (key: string): string => `${key} ${EXTERNAL_SUFFIX}`;
export const MAJOR_BADGE = "Major";
export const ADD_FROM_ANOTHER_EVENT = "Add from another event";
export const REMOVE_REFERENCE = "Remove";
/** "Channels from other events" / "Messages from other events": the heading of the card under a list. */
export const externalRefsTitle = (kind: ExternalItemKind): string => (kind === "channel" ? "Channels from other events" : "Messages from other events");
export const externalRefsEmpty = (kind: ExternalItemKind): string =>
  `Use a ${kind} that another published event defines. It stays a copy of that published version until you update it.`;
/** "v1.2 → v2.0 available": the line under a reference whose source event published a later version. */
export const newerVersionText = (current: string, latest: string): string => `v${current} → v${latest} available`;
export const updateToText = (latest: string): string => `Update to v${latest}`;
/** The accessible name of a row's Update button: the visible words first, then WHICH reference ("Update to v2.0: Order placed"). */
export const updateToLabel = (latest: string, title: string): string => `${updateToText(latest)}: ${title}`;
/** The accessible name of a row's Remove button ("Remove Order placed"). */
export const removeReferenceLabel = (title: string): string => `${REMOVE_REFERENCE} ${title}`;
/** "Used by 2 operations" / "Used by 1 channel and 2 operations": what removing a reference would touch. */
export const usedByText = (channels: number, operations: number): string => {
  const parts = [
    channels > 0 ? `${channels} ${channels === 1 ? "channel" : "channels"}` : null,
    operations > 0 ? `${operations} ${operations === 1 ? "operation" : "operations"}` : null,
  ].filter(Boolean);
  return `Used by ${parts.join(" and ")}`;
};
export const DETAILS_UNAVAILABLE = "Details unavailable";

// The copy under an operation's messages. On a LOCAL channel the list is what that channel allows; on an EXTERNAL channel (one another
// event owns) every message of this event is offered, because nothing can be checked against a channel the event does not own.
export const operationMessagesHint = (externalChannel: boolean): string =>
  externalChannel ? "Every message of this event can be used on a channel from another event." : "Only messages allowed on the chosen channel are listed.";
/** What the operation's own messages list says when it is empty (`channelKey` names the local channel; an external channel names the event). */
export const operationMessagesEmpty = (channelKey: string, externalChannel: boolean): string =>
  externalChannel
    ? "This event has no messages yet. Add one in Messages; an operation can be saved without any."
    : `Channel "${channelKey}" has no messages yet. Allow messages on it in Channels or Messages; an operation can be saved without any.`;
/** The same for the messages of the operation's reply. */
export const replyMessagesEmpty = (channelKey: string, externalChannel: boolean): string =>
  externalChannel ? "This event has no messages yet. Add one in Messages." : `Channel "${channelKey}" has no messages yet. Allow messages on it in Channels or Messages.`;

/**
 * The sentence under a reference whose update was refused because the latest version really no longer has the item (its own item
 * list was checked) and operations still use it.
 */
export const updateRefusedText = (itemKey: string, latest: string, operations: string[]): string => {
  const one = operations.length === 1;
  const names = operations.map((k) => `"${k}"`).join(", ");
  return `Cannot update to v${latest}: it no longer has "${itemKey}", and ${one ? "operation" : "operations"} ${names} ${one ? "uses" : "use"} it. Take it out of ${one ? "that operation" : "those operations"} first.`;
};
/** The sentence under a reference whose update was refused because the latest version's items could not be checked: nothing was changed. */
export const updateUnconfirmedText = (itemKey: string, latest: string): string =>
  `Cannot update to v${latest}: it may no longer have "${itemKey}", and its items could not be checked. Nothing was changed; try again.`;
/**
 * The note left after an update removed a reference no operation used: the latest version no longer has the item. `channels` are the
 * local channels whose allowed messages it was also taken out of (the update strips it from them silently), named and counted.
 */
export const updateRemovedText = (itemKey: string, latest: string, channels: string[]): string => {
  const alsoTaken = channels.length === 0
    ? ""
    : ` It was also taken out of the allowed messages of ${channels.length} ${channels.length === 1 ? "channel" : "channels"} (${channels.join(", ")}).`;
  return `Removed "${itemKey}": v${latest} no longer has it and no operation used it.${alsoTaken}`;
};
/** The question asked before removing a reference that is in use. `used` is what uses it ("2 operations (a, b)"), `consequence` what removing does. */
export const removeConfirmText = (kind: ExternalItemKind, key: string, used: string, consequence: string): string =>
  `External ${kind} "${key}" is used by ${used}. Removing it will ${consequence}. Remove it?`;

/** The picker dialog: event → version → item. */
export const addExternalTitle = (kind: ExternalItemKind): string => `Add a ${kind} from another event`;
export const pickerStepText = (step: 1 | 2 | 3, kind: ExternalItemKind): string => {
  const name = step === 1 ? "Choose the event" : step === 2 ? "Choose the version" : `Choose the ${kind}`;
  return `Step ${step} of 3 · ${name}`;
};
export const SEARCH_EVENTS_PLACEHOLDER = "Search published events by name, domain or product…";
export const SEARCH_EVENTS_LABEL = "Search published events";
export const EVENTS_LOADING = "Loading published events…";
export const noEventsText = (query: string): string => (query === "" ? "No other event has been published yet." : `No published event matches “${query}”.`);
export const loadFailedText = (what: string, reason: string): string => `Could not load ${what}: ${reason}`;
export const VERSIONS_LABEL = "Version";
export const VERSIONS_LOADING = "Loading versions…";
export const NO_VERSIONS = "This event has no version that can be referenced.";
export const LATEST_BADGE = "Latest";
export const publishedOnText = (day: string): string => `Published ${day}`;
export const filterItemsLabel = (kind: ExternalItemKind): string => `Filter the ${kind === "channel" ? "channels" : "messages"}`;
export const ITEMS_LOADING = "Loading…";
export const noItemsText = (kind: ExternalItemKind, versionLabel: string): string => `Version v${versionLabel} has no ${kind === "channel" ? "channels" : "messages"} to use.`;
export const ALREADY_USED = "Already used";
export const PICKER_BACK = "Back";
export const PICKER_NEXT = "Next";
export const PICKER_ADD = "Add";
export const PICKER_CANCEL = "Cancel";
