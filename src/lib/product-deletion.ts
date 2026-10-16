/**
 * Product delete guard (pure, client-safe).
 *
 * Deleting a product cascades (FK ON DELETE CASCADE) its entities, its
 * product-level Data Types (shared enums, custom scalars, unions) and APIs
 * (service definitions), and its Events assets (events, and traits). None of those
 * may be lost silently, so a product is deletable only when it owns none of them.
 */

/**
 * Events assets: self-contained events live at product level (messages and channels are parts of an event, not assets), and
 * traits at tenant or domain level, so a product never owns a trait and a domain owns its own plus its products' events.
 */
export interface EventsAssetCounts {
  traits: number;
  eventSpecs: number;
}

export interface ProductContentCounts extends EventsAssetCounts {
  entities: number;
  sharedEnums: number;
  customScalars: number;
  unionTypes: number;
  services: number;
}

/**
 * Prisma `_count.select` for the Events assets a Product or Domain delete would cascade. Product-level rows
 * always carry their product's `domainId` (CHECK + resolveScope), so the same select counts them on a Domain too.
 */
export const EVENTS_ASSET_COUNT_SELECT = {
  traits: true,
  eventSpecs: true,
} as const;

export const NO_EVENTS_ASSETS: EventsAssetCounts = { traits: 0, eventSpecs: 0 };

/** Product-level Data Types = shared enums + custom scalars + union types. */
export function productDataTypeCount(c: Pick<ProductContentCounts, "sharedEnums" | "customScalars" | "unionTypes">): number {
  return c.sharedEnums + c.customScalars + c.unionTypes;
}

export function eventsAssetTotal(c: EventsAssetCounts): number {
  return c.traits + c.eventSpecs;
}

function countLabel(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "1 trait", "3 events" for every non-zero kind (fixed order). */
export function eventsAssetParts(c: EventsAssetCounts): string[] {
  const parts: string[] = [];
  if (c.traits > 0) parts.push(countLabel(c.traits, "trait", "traits"));
  if (c.eventSpecs > 0) parts.push(countLabel(c.eventSpecs, "event", "events"));
  return parts;
}

/**
 * Join independent blocker sentences into one message: a single blocker is returned untouched, several are
 * separated by sentence breaks. Null when there is nothing to report.
 */
export function combineBlockers(blockers: Array<string | null | undefined>): string | null {
  const present = blockers.filter((b): b is string => typeof b === "string" && b.length > 0);
  if (present.length === 0) return null;
  return present.map((b, i) => (i < present.length - 1 && !b.endsWith(".") ? `${b}.` : b)).join(" ");
}

/**
 * The block message when the product still owns anything a delete would cascade,
 * or null when it is empty and safe to delete.
 */
export function productDeleteBlocker(c: ProductContentCounts): string | null {
  const parts: string[] = [];
  if (c.entities > 0) parts.push(countLabel(c.entities, "entity", "entities"));
  const dataTypes = productDataTypeCount(c);
  if (dataTypes > 0) parts.push(countLabel(dataTypes, "Data Type", "Data Types"));
  if (c.services > 0) parts.push(countLabel(c.services, "API", "APIs"));
  parts.push(...eventsAssetParts(c));
  if (parts.length === 0) return null;
  return `Delete the product's ${joinList(parts)} before removing it`;
}
