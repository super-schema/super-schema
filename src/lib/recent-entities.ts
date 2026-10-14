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
