// src/services/events/delete-guards.ts
//
// What is left of the legacy delete guards after the Message / Channel catalog was dropped (migration
// 20261020_drop_legacy_event_catalog). The edge-based guards in `event-guards.ts` are the guards now; this file only keeps
// the scope type they share.

/** What is being deleted. `tenantId` bounds the lookup: events of other tenants are never read, counted or named. */
export type DeleteGuardScope =
  | { kind: "product"; productId: string; tenantId: string }
  | { kind: "domain"; domainId: string; tenantId: string };
