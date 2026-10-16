// src/features/events/workspace/trait-list-meta.ts
// What the Message properties list shows about a library trait besides its name: is it built in (read-only) and how many properties it
// brings. Read from the stored `spec`, client-safe.
import { isBundledTrait, propertySummary } from "@/lib/events/bundled-traits";

export interface TraitListMeta {
  /** A built-in set (`x-bundled` in its spec): shown locked, never editable. */
  bundled: boolean;
  /** The properties of its inline headers schema (0 for an operation set and for one that defines none inline). */
  propertyCount: number;
}

export function traitListMeta(spec: unknown): TraitListMeta {
  return { bundled: isBundledTrait(spec), propertyCount: propertySummary(spec).length };
}
