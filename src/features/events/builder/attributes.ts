// src/features/events/builder/attributes.ts
// Metadata attributes of an event channel, message or operation: the `extensions` map edited by the "Metadata" section.
import type { JsonValue } from "@/lib/event-specs/types";
import type { MetadataAttributeDefinition, MetadataAttributeTarget } from "@/types/schemas/metadata-attribute";

/** The item with `extensions` set to `next` (the key is removed when `next` is undefined or empty). */
export function withExtensions<T extends { extensions?: Record<string, JsonValue> }>(item: T, next: Record<string, unknown> | undefined): T {
  const { extensions: _previous, ...rest } = item;
  return (next && Object.keys(next).length > 0 ? { ...rest, extensions: next as Record<string, JsonValue> } : rest) as T;
}

/** How many attributes an item carries (the pane's count). */
export const extensionCount = (item: { extensions?: Record<string, JsonValue> }): number => Object.keys(item.extensions ?? {}).length;

/** True when the "Metadata" pane has something to show: the dictionary defines an attribute for `target`, or the item already carries some. */
export const hasAttributes = (
  definitions: readonly MetadataAttributeDefinition[] | undefined,
  target: MetadataAttributeTarget,
  item: { extensions?: Record<string, JsonValue> },
): boolean => extensionCount(item) > 0 || (definitions ?? []).some((d) => d.targets.includes(target));
