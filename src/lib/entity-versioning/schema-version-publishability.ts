/**
 * Which stored schema versions may be published (multi-entity emission, Task 8, carried over from Task 7).
 *
 * A schema version generated from the entity page is generated from the entity's CURRENT saved state (draft mode): the root is at draft
 * state by definition, and every referenced entity resolves to its latest SAVED definition, drafts included. Such output is a
 * preview of what the entity references right now, and it cannot be published as it is: a published schema can never contain draft
 * content of a referenced entity. It becomes publishable once it is regenerated in published mode (each referenced entity at its latest
 * published version or pin), which needs those entities to be published first.
 *
 * The rule, precisely: a stored schema version is unpublishable if and only if its `resolution` lists a REFERENCED entity (any entry
 * other than the root) whose `source` is `draft`. The root's own draft state does not count (`resolution.preview` does count the root,
 * so every page-generated version is a `preview`, even with no references at all, and none of those is refused for that alone).
 * A version without a `resolution` (a DB or native target, or one stored before references) has nothing to refuse and publishes as
 * it always did. Pure and client-safe; tolerant of malformed stored data (read as nothing to refuse, never throws).
 */

import { qualifiedName, type EntityRef } from "@/lib/references/entity-reference";
import type { SchemaVersionResolution } from "@/types/schema-version";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `domain / product / entity`: how a person reads a qualified name (the stored form is `domain/product/entity`). */
const describeRef = (ref: EntityRef): string => qualifiedName(ref).split("/").join(" / ");

const MAX_NAMED = 5;

/**
 * The entities, other than `rootEntityId`, that `resolution` records at draft state: what makes a stored version a preview that
 * cannot be published. The root is the entry carrying its id, or (when none does) the first entry, which is the root by construction.
 */
export function draftReferencedEntities(resolution: SchemaVersionResolution | undefined, rootEntityId: string): EntityRef[] {
  if (!isRecord(resolution) || !Array.isArray(resolution.entities)) return [];
  const entries = (resolution.entities as unknown[]).flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.ref)) return [];
    const { domain, product, entity } = entry.ref;
    if (typeof domain !== "string" || typeof product !== "string" || typeof entity !== "string") return [];
    return [{ ref: entry.ref as unknown as EntityRef, source: entry.source }];
  });
  const rootIndex = entries.findIndex((entry) => entry.ref.entityId === rootEntityId);
  return entries
    .filter((entry, index) => index !== (rootIndex === -1 ? 0 : rootIndex) && entry.source === "draft")
    .map((entry) => entry.ref);
}

/** The refusal shown when a stored version resolved referenced entities at draft state: names them and says how to fix it. */
export function draftReferenceRefusal(drafts: readonly EntityRef[]): string {
  const named = drafts.slice(0, MAX_NAMED).map(describeRef).join(", ");
  const more = drafts.length > MAX_NAMED ? ` +${drafts.length - MAX_NAMED} more` : "";
  const them = drafts.length === 1 ? "it" : "them";
  return `This schema version was generated from the saved draft of ${named}${more}, so it is a preview and cannot be published: a published schema never contains draft content of an entity it references. Publish ${them} first, then regenerate this schema in published mode and publish the new version.`;
}
