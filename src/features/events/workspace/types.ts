// src/features/events/workspace/types.ts
import type { Linked, TraitListItem } from "@/lib/events/types";

/** Client-safe: shared by the server loader and the Domain / Enterprise Message properties tab component. */

/** A library trait as the tab lists it: the list item with its URL, plus what the cards show (absent when the loader does not know it). */
export type TraitTabItem = Linked<TraitListItem> & { bundled?: boolean; propertyCount?: number };

export interface TraitGroup {
  label: string;
  href: string;
  traits: TraitTabItem[];
}

export interface TraitsTabData {
  own: TraitTabItem[];
  /** Traits of broader levels (Enterprise), read-only here. */
  inherited: TraitGroup[];
}

export const EMPTY_TRAITS_TAB: TraitsTabData = { own: [], inherited: [] };
