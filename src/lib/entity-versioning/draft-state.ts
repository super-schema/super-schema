import type { PrismaClient, Prisma } from "@/generated/prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Entity metadata keys that never dirty the draft: system bookkeeping
 * (per-target emitted schemas, type overrides, legacy 2-22 version data,
 * Story 12.7 migration flags) and lifecycle state (deprecation travels with a
 * status transition). Every other key — tags, owner, relationships,
 * retentionPolicy, custom, and any key added later — is a draft change.
 */
export const DRAFT_NEUTRAL_METADATA_KEYS: ReadonlySet<string> = new Set([
  "schemaVersions",
  "schemaTargetTypeOverrides",
  "semanticVersion",
  "versionHistory",
  "typespecMigration",
  "deprecation",
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

/** Flag the entity's draft as diverged from its latest published version. */
export async function markEntityDraftChanged(db: Db, entityId: string): Promise<void> {
  await db.entity.update({ where: { id: entityId }, data: { hasUnpublishedChanges: true }, select: { id: true } });
}
