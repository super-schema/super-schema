/**
 * Recent entity tracking via localStorage.
 * Stores the last 5 accessed entity IDs.
 */

const STORAGE_KEY = "super-schema:recent-entities";
const MAX_RECENT = 5;

export interface RecentEntityEntry {
  entityId: string;
  /** null for tenant-level (enterprise) entities. */
  domainSlug: string | null;
  entityName: string;
  domainName: string;
  /**
   * Entity slug, needed to rebuild the canonical URL. Absent on legacy
   * entries stored before slugs were persisted.
   */
  slug?: string;
  /** null for tenant-level entities; absent on legacy entries. */
  productSlug?: string | null;
}

const ENTRIES_KEY = "super-schema:recent-entity-entries";

export function getRecentEntityIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function getRecentEntityEntries(): RecentEntityEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(ENTRIES_KEY) || "[]");
  } catch {
    return [];
  }
}

/**
 * A recent entry can be navigated from its stored data only when it carries
 * the slug the canonical URL is built from. Legacy entries (id + names only)
 * must be resolved against the fetched entity list instead — a URL is never
 * fabricated from the id.
 */
export function hasStoredEntityLocation(
  entry: RecentEntityEntry
): entry is RecentEntityEntry & { slug: string; productSlug: string | null } {
  return Boolean(entry.slug) && entry.productSlug !== undefined;
}

export function trackRecentEntity(entry: RecentEntityEntry): void {
  if (typeof window === "undefined") return;

  // Update ID list (backward compat)
  const ids = getRecentEntityIds().filter((id) => id !== entry.entityId);
  ids.unshift(entry.entityId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));

  // Update full entries list
  const entries = getRecentEntityEntries().filter(
    (e) => e.entityId !== entry.entityId
  );
  entries.unshift(entry);
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries.slice(0, MAX_RECENT)));
}

export function clearRecentEntities(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(ENTRIES_KEY);
}
