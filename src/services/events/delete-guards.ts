// src/services/events/delete-guards.ts
//
// What is left of the legacy delete guards after the Message / Channel catalog was dropped (migration
// 20261020_drop_legacy_event_catalog). The edge-based guards in `event-guards.ts` are the guards now.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ServiceError } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

/** What is being deleted. `tenantId` bounds the lookup: events of other tenants are never read, counted or named. */
export type DeleteGuardScope =
  | { kind: "product"; productId: string; tenantId: string }
  | { kind: "domain"; domainId: string; tenantId: string };

// ── Trait in-use guard (compatibility shim) ──────────────────────────────────────────────────────────────────────────────
//
// `trait.service.ts` still calls `findTraitReferrers` + `assetInUseError` ahead of the event guard
// (`findLibraryTraitEventReferrers` + `withEventsInUse`). The only things those two ever named were legacy catalog messages
// and version-1 event specs, and neither can exist any more (the migration refuses to run while one does). They are kept
// as no-ops so that file compiles unchanged; delete them together with the two calls in `deleteTrait`.

/** Which asset the guard protects; also the noun used in the error. */
export type GuardedAssetKind = "Trait";

/** A message or event spec that still uses a trait. */
export interface AssetReferrer {
  kind: "Message" | "Event spec";
  id: string;
  name: string;
  /** Labels ("1.0") of the PUBLISHED versions that reference the asset, oldest first; empty when only the live draft does. */
  versions: string[];
  /** The live draft references the asset too. */
  draft: boolean;
}

export interface AssetReferrers {
  referrers: AssetReferrer[];
  /** True when a source had more matches than the scan limit: the list is a prefix. */
  truncated: boolean;
}

/** Always empty: legacy catalog messages and version-1 event specs no longer exist. See the note above. */
export async function findTraitReferrers(db: Db, trait: { id: string; tenantId: string }): Promise<AssetReferrers> {
  void db;
  void trait;
  return { referrers: [], truncated: false };
}

/** Null while nothing is listed (always, see `findTraitReferrers`). */
export function assetInUseError(kind: GuardedAssetKind, name: string, found: AssetReferrers): ServiceError | null {
  if (found.referrers.length === 0) return null;
  return {
    code: "IN_USE",
    message: `${kind} "${name}" cannot be deleted: it is still in use.`,
    details: { referrers: found.referrers, truncated: found.truncated },
  };
}
