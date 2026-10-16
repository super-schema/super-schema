// src/features/events/builder/traits.ts
// The pure side of the Traits section: who uses a trait, what a removal has to clean up, and the key a library trait is added under.
import type { TraitKind } from "@/lib/event-specs/types";
import type { EventDocument } from "@/lib/events/document/types";
import { suggestKey } from "@/lib/events/templates/keys";
import { takenKeys } from "./auto-key";

/** The keys of the messages and operations that carry a trait in their `traitKeys`. */
export interface TraitUsage { messages: string[]; operations: string[] }

export function traitUsage(doc: EventDocument, key: string): TraitUsage {
  return {
    messages: doc.messages.filter((m) => m.traitKeys.includes(key)).map((m) => m.key),
    operations: doc.operations.filter((o) => o.traitKeys.includes(key)).map((o) => o.key),
  };
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * "Used by 2 messages" for a message trait, "Used by 1 operation" for an operation trait. A message trait on an operation (or the
 * reverse) is a broken document; it is named too, so the number never hides a use.
 */
export function usageText(kind: TraitKind, usage: TraitUsage): string {
  const own = kind === "MESSAGE" ? count(usage.messages.length, "message") : count(usage.operations.length, "operation");
  const other = kind === "MESSAGE"
    ? (usage.operations.length > 0 ? count(usage.operations.length, "operation") : null)
    : (usage.messages.length > 0 ? count(usage.messages.length, "message") : null);
  return `Used by ${own}${other ? ` and ${other}` : ""}`;
}

/**
 * `doc` without the trait at `index`, and without its key in every `messages[].traitKeys` / `operations[].traitKeys` (so the
 * document does not end up pointing at a trait that is gone). While another trait still has the same key (a duplicate in a broken
 * document) the references stay. Items that hold no reference keep their identity; an index outside the list changes nothing.
 */
export function removeTrait(doc: EventDocument, index: number): EventDocument {
  const trait = doc.traits[index];
  if (!trait) return doc;
  const traits = doc.traits.filter((_, i) => i !== index);
  if (traits.some((t) => t.key === trait.key)) return { ...doc, traits };
  const strip = <T extends { traitKeys: string[] }>(item: T): T => (item.traitKeys.includes(trait.key) ? { ...item, traitKeys: item.traitKeys.filter((k) => k !== trait.key) } : item);
  return { ...doc, traits, messages: doc.messages.map(strip), operations: doc.operations.map(strip) };
}

/** The key a library trait is added under: its name, kept unique among the document's trait keys (`Audit-log`, `Audit-log-2`, …). */
export function libraryTraitKey(doc: EventDocument, name: string): string {
  return suggestKey("trait", { name }, takenKeys(doc, "trait"));
}
