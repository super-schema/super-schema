// src/features/events/builder/traits.ts
// The pure side of the Message properties section and the cards on a message and an operation: who uses a set, what a removal has to
// clean up, how a set is added (from the library, blank) and applied to ONE message or operation in a single step, and what a set is
// called and how many properties it brings. A "set" is a document trait (`doc.traits[]`): internal names keep saying trait.
import type { TraitKind } from "@/lib/event-specs/types";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { propertySummary } from "@/lib/events/bundled-traits";
import { isLibraryTrait, type DocTrait, type EventDocument } from "@/lib/events/document/types";
import { suggestKey } from "@/lib/events/templates/keys";
import type { EntityPin } from "@/lib/events/types";
import { autoRenameKey, newKey, takenKeys } from "./auto-key";
import type { LibraryTraitOption } from "./EventBuilder";
import { newPropertiesLabel } from "./labels";

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

type LibraryRef = Extract<DocTrait, { libraryTraitId: string }>;

/** The entry of the document that points at the library trait `libraryTraitId`, if the event already uses it. */
export function libraryEntry(doc: EventDocument, libraryTraitId: string): LibraryRef | undefined {
  return doc.traits.find((t): t is LibraryRef => isLibraryTrait(t) && t.libraryTraitId === libraryTraitId);
}

/** What the chooser hands back: a library (or built-in) trait, or a blank local set of one kind. */
export type TraitChoice = { type: "library"; option: LibraryTraitOption } | { type: "blank"; kind: TraitKind };

/**
 * `doc` with the library trait added as `{ key, kind, libraryTraitId }` under a key made from its name, and that key. When the event
 * already uses this library trait the entry is reused (no second entry, the document is returned as it is).
 */
export function addLibraryTrait(doc: EventDocument, option: Pick<LibraryTraitOption, "id" | "name" | "kind">): { doc: EventDocument; key: string } {
  const existing = libraryEntry(doc, option.id);
  if (existing) return { doc, key: existing.key };
  const key = libraryTraitKey(doc, option.name);
  return { doc: { ...doc, traits: [...doc.traits, { key, kind: option.kind, libraryTraitId: option.id }] }, key };
}

/** `doc` with a blank local set of `kind` under a placeholder key (named from its name or title later), and that key. */
export function addBlankTrait(doc: EventDocument, kind: TraitKind): { doc: EventDocument; key: string } {
  const key = newKey(doc, "trait");
  return { doc: { ...doc, traits: [...doc.traits, { key, kind, spec: {} }] }, key };
}

/** Add what the chooser picked to the document (reusing a library entry the event already has). */
export function addChoice(doc: EventDocument, choice: TraitChoice): { doc: EventDocument; key: string } {
  return choice.type === "library" ? addLibraryTrait(doc, choice.option) : addBlankTrait(doc, choice.kind);
}

/** The message or operation a set is applied to. */
export type TraitTarget = { kind: "message" | "operation"; key: string };

const withTraitKeys = (doc: EventDocument, target: TraitTarget, change: (keys: string[]) => string[]): EventDocument => {
  if (target.kind === "message") {
    return { ...doc, messages: doc.messages.map((m) => (m.key === target.key ? { ...m, traitKeys: change(m.traitKeys) } : m)) };
  }
  return { ...doc, operations: doc.operations.map((o) => (o.key === target.key ? { ...o, traitKeys: change(o.traitKeys) } : o)) };
};

/** `doc` with the set `traitKey` applied to the target (once; an applied set keeps its place). */
export function applyTrait(doc: EventDocument, target: TraitTarget, traitKey: string): EventDocument {
  return withTraitKeys(doc, target, (keys) => (keys.includes(traitKey) ? keys : [...keys, traitKey]));
}

/**
 * `doc` with the set `traitKey` taken off the target. A library entry that nothing uses any more is removed with it (it only
 * pointed at the library, so nothing the user wrote is lost); a local set stays in the Message properties section.
 */
export function unapplyTrait(doc: EventDocument, target: TraitTarget, traitKey: string): EventDocument {
  const next = withTraitKeys(doc, target, (keys) => keys.filter((k) => k !== traitKey));
  const entry = next.traits.find((t) => t.key === traitKey);
  if (!entry || !isLibraryTrait(entry)) return next;
  const usage = traitUsage(next, traitKey);
  if (usage.messages.length + usage.operations.length > 0) return next;
  return { ...next, traits: next.traits.filter((t) => t !== entry) };
}

/**
 * Once the user leaves a local set's form: a placeholder key (`trait`, `trait-2`) becomes a key made from the set's name (a message set) or
 * title (an operation set), and every reference follows (`renameKey`). Returns `doc` and the same key when there is nothing to name it by,
 * the key is no placeholder any more, or the set is a library entry. Later edits never rename it again.
 */
export function autoNameTrait(doc: EventDocument, key: string): { doc: EventDocument; key: string } {
  const index = doc.traits.findIndex((t) => t.key === key);
  const trait = doc.traits[index];
  if (!trait || isLibraryTrait(trait)) return { doc, key };
  const next = autoRenameKey(doc, "trait", key, { name: trait.spec.name, title: trait.spec.title });
  return next === doc ? { doc, key } : { doc: next, key: next.traits[index].key };
}

/** The library option a library entry points at. */
export function optionOf(trait: DocTrait, library: LibraryTraitOption[]): LibraryTraitOption | undefined {
  return isLibraryTrait(trait) ? library.find((l) => l.id === trait.libraryTraitId) : undefined;
}

/** What a set is called in a list or a chip: its name or title, else the key once it has a real one, else "New message properties". */
export function traitLabel(trait: DocTrait, library: LibraryTraitOption[]): string {
  if (isLibraryTrait(trait)) return optionOf(trait, library)?.name ?? trait.key;
  const spec = trait.spec;
  const named = [spec.name, spec.title].find((v): v is string => typeof v === "string" && v.trim() !== "");
  if (named) return named.trim();
  return /^trait(-\d+)?$/.test(trait.key) ? newPropertiesLabel(trait.kind) : trait.key;
}

/** True for a built-in set (a library entry whose option is marked `bundled`): read-only everywhere. */
export function isBuiltInEntry(trait: DocTrait, library: LibraryTraitOption[]): boolean {
  return optionOf(trait, library)?.bundled === true;
}

/** The count of properties a library option brings (`properties`, else its spec's inline headers), or null when it does not say. */
export function optionPropertyCount(option: Pick<LibraryTraitOption, "spec" | "properties">): number | null {
  if (option.properties) return option.properties.length;
  return option.spec ? propertySummary(option.spec).length : null;
}

/** The count of properties of a set in the document: a local message set counts its inline headers; an operation set has none (null). */
export function traitPropertyCount(trait: DocTrait, library: LibraryTraitOption[]): number | null {
  if (isLibraryTrait(trait)) {
    const option = optionOf(trait, library);
    return option ? optionPropertyCount(option) : null;
  }
  return trait.kind === "MESSAGE" ? propertySummary(trait.spec).length : null;
}

/** The headers schema a set defines inline: a local set's `spec.headers`, a library set's from the options; undefined when unknown. */
export function traitHeaders(trait: DocTrait, library: LibraryTraitOption[]): unknown {
  if (isLibraryTrait(trait)) return optionOf(trait, library)?.spec?.headers;
  return trait.spec.headers;
}

/** Where the properties of a trait pinned to an entity come from (what its table says instead of "No properties"). `href` is null when the entity has no known address. */
export interface PinnedHeaders { name: string; versionLabel: string | null; href: string | null }

/** `pin` (a legacy trait's headers entity; null when a stored trait has none) described for the table; undefined without a pin. Only the latest version's label is known, an older pin names the entity alone. */
export function pinnedHeaders(pin: EntityPin | null | undefined, entityOptions: readonly EntityOption[]): PinnedHeaders | undefined {
  if (!pin) return undefined;
  const entity = entityOptions.find((e) => e.id === pin.entityId);
  const versionLabel = entity && pin.entityVersionId !== null && pin.entityVersionId === entity.latestVersionId ? entity.latestVersionLabel : null;
  return { name: entity?.name ?? pin.entityId, versionLabel, href: entity?.href ?? null };
}
