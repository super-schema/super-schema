import type { PrismaClient, Prisma } from "@/generated/prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Entity metadata keys that never dirty the draft: system bookkeeping
 * (per-target emitted schemas, type overrides, legacy 2-22 version data,
 * Story 12.7 migration flags, the `sourceStale` marker) and lifecycle state
 * (deprecation travels with a status transition). Every other key — tags,
 * owner, relationships, retentionPolicy, custom, and any key added later — is
 * a draft change.
 */
export const DRAFT_NEUTRAL_METADATA_KEYS: ReadonlySet<string> = new Set([
  "schemaVersions",
  "schemaTargetTypeOverrides",
  "semanticVersion",
  "versionHistory",
  "typespecMigration",
  "deprecation",
  "sourceStale",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** True when any non-neutral metadata key differs between before and after. */
export function metadataChangesDraft(before: unknown, after: unknown): boolean {
  const a = asRecord(before);
  const b = asRecord(after);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (DRAFT_NEUTRAL_METADATA_KEYS.has(key)) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return true;
  }
  return false;
}

/** Whether an updateEntity input changes the draft (status-only transitions do not). */
export function entityUpdateTouchesDraft(
  before: { name: string; description: string; metadata: unknown },
  input: { name?: string; description?: string; status?: string; metadata?: unknown }
): boolean {
  if (input.name !== undefined && input.name !== before.name) return true;
  if (input.description !== undefined && input.description !== before.description) return true;
  if (input.metadata !== undefined && metadataChangesDraft(before.metadata, input.metadata)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Source staleness (controller rulings R42, R45)
//
// `entity.typespecSource` is canonical (12.5), but name, description, tags and
// other metadata, and the field rows are all rendered into it. Every draft edit
// that does not go through the TypeSpec source tab (quick field editor, REST /
// tRPC routes, TypeSpec preview "apply", rename, description, tags, owner,
// retention, relationships, ...) therefore leaves the stored source behind. Those
// paths set `metadata.sourceStale = true`; only the TypeSpec source save (which
// writes source + fields consistently) and publish (which regenerates) clear it.
// There is deliberately no opt-out on the helpers below: the TypeSpec source save
// does not use them, it writes source + flag inline and clears the marker.
//
// The statements are plain SQL strings so they are atomic (jsonb_set / `-` touch
// one key and never clobber concurrent metadata writes) and so the PGlite test
// can run the exact same text.
// ---------------------------------------------------------------------------

/** `metadata` as an object: NULL / JSON null / scalars become `{}`. */
const METADATA_AS_OBJECT = `(CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata" ELSE '{}'::jsonb END)`;

/** $1 = entity id. Marks the draft changed AND the stored source stale in one statement. */
export const MARK_DRAFT_CHANGED_SQL =
  `UPDATE "entities" SET "hasUnpublishedChanges" = true, "updatedAt" = CURRENT_TIMESTAMP, ` +
  `"metadata" = jsonb_set(${METADATA_AS_OBJECT}, '{sourceStale}', 'true'::jsonb, true) WHERE "id" = $1`;

/**
 * $1 = entity id, $2 = JSON array text of the tags. Sets `metadata.tags` and nothing else (one key, so a
 * concurrent metadata write is never clobbered). Used by the TypeSpec source save: the source is canonical,
 * so its `x-tags` become the entity's tags and survive the next regeneration.
 */
export const SET_ENTITY_TAGS_SQL =
  `UPDATE "entities" SET "metadata" = jsonb_set(${METADATA_AS_OBJECT}, '{tags}', $2::jsonb, true) ` +
  `WHERE "id" = $1`;

/** $1 = entity id. Clears the stale marker (the TypeSpec source save wrote source + fields consistently). */
export const CLEAR_SOURCE_STALE_SQL =
  `UPDATE "entities" SET "metadata" = "metadata" - 'sourceStale' ` +
  `WHERE "id" = $1 AND jsonb_typeof("metadata") = 'object'`;

/**
 * $1 = entity id, $2 = regenerated source. Used by publish: writes the regenerated source back and
 * clears `sourceStale`, plus the Story 12.7 `typespecMigration` flag (the entity now has compiling source).
 */
export const WRITE_BACK_SOURCE_SQL =
  `UPDATE "entities" SET "typespecSource" = $2, "updatedAt" = CURRENT_TIMESTAMP, ` +
  `"metadata" = (${METADATA_AS_OBJECT} - 'sourceStale' - 'typespecMigration') WHERE "id" = $1`;

/** True when entity metadata carries the stale-source marker. */
export function isSourceStale(metadata: unknown): boolean {
  return asRecord(metadata).sourceStale === true;
}

/**
 * For writers that already rewrite the whole metadata object: apply the stale marker when this edit
 * changes the draft, or when the stored metadata was already stale (so a caller-supplied copy that lacks
 * the server-owned marker can never clear it).
 */
export function withSourceStale(
  stored: unknown,
  next: Record<string, unknown>,
  changesDraft: boolean
): Record<string, unknown> {
  return changesDraft || isSourceStale(stored) ? { ...next, sourceStale: true } : next;
}

/**
 * Call after any draft edit that did not go through the TypeSpec source save: flags the draft changed
 * AND the stored typespecSource stale, in one atomic statement.
 */
export async function markEntityDraftChanged(db: Db, entityId: string): Promise<void> {
  await db.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId);
}
