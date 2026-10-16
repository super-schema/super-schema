// src/features/events/workspace/types.ts
import type { Linked, TraitListItem } from "@/lib/events/types";

/** Client-safe: shared by the server loader and the Domain / Enterprise Traits tab component. */

export interface TraitGroup {
  label: string;
  href: string;
  traits: Linked<TraitListItem>[];
}

export interface TraitsTabData {
  own: Linked<TraitListItem>[];
  /** Traits of broader levels (Enterprise), read-only here. */
  inherited: TraitGroup[];
}

export const EMPTY_TRAITS_TAB: TraitsTabData = { own: [], inherited: [] };
