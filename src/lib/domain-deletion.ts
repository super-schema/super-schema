/**
 * Domain delete guard (pure, client-safe).
 *
 * Deleting a domain cascades its products and every domain- AND product-level Data Type / API / Events asset
 * (FK ON DELETE CASCADE). Data Types and APIs go with it after the admin confirms the listed counts, but
 * entities and Events assets (channels, messages, traits, event specs) block the delete: none of them may be
 * lost silently. Events assets are counted at every level the domain owns them — product-level rows carry the
 * product's `domainId`, domain-level traits carry only the domain's.
 */
import { eventsAssetParts, eventsAssetTotal, joinList, type EventsAssetCounts } from "./product-deletion";

export interface DomainDeleteCounts extends EventsAssetCounts {
  entities: number;
}

/**
 * The block message when the domain (or its products) still owns entities or Events assets, or null when the
 * delete may proceed. The entities-only wording is the long-standing one and stays byte-for-byte unchanged.
 */
export function domainDeleteBlocker(c: DomainDeleteCounts): string | null {
  const parts: string[] = [];
  if (c.entities > 0) parts.push(c.entities === 1 ? "1 entity" : `${c.entities} entities`);
  parts.push(...eventsAssetParts(c));
  if (parts.length === 0) return null;
  const single = parts.length === 1 && c.entities + eventsAssetTotal(c) === 1;
  const subject = single ? `${parts[0]} exists` : `${joinList(parts)} exist`;
  return `Cannot delete - ${subject} in this domain or its products. Move or delete ${single ? "it" : "them"} first.`;
}
