// src/features/events/builder/labels.ts
// The user-facing names of "traits", in one place. AsyncAPI calls them traits; users do not understand that word, so the UI says
// "Message properties" and keeps "(Trait)" in brackets as the technical secondary text. Change a name here and it changes everywhere
// (the builder section, the Enterprise / Domain tab and sidebar leaf, the create menu, page titles, empty states, tooltips).
// Internal names (section id `traits`, URL `?tab=traits`, test ids `trait-*`) are NOT user-facing and stay as they are. Pure, client-safe.
import type { TraitKind } from "@/lib/event-specs/types";

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
