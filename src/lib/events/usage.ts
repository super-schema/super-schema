// src/lib/events/usage.ts
import { assetHref } from "@/lib/navigation/asset-href";
import { ok, err, type Result } from "@/types/result";

/**
 * What "Who uses X?" can be asked about: an entity (events, library traits and other entities pin its versions) or an
 * event (other events reference its published versions as external references).
 */
export type UsageSubject = { kind: "entity"; entityId: string } | { kind: "event"; eventId: string };
export type UsageFromKind = "ENTITY_VERSION" | "EVENT_SPEC" | "EVENT_SPEC_VERSION" | "TRAIT";

export interface UsageRow {
  id: string;
  fromKind: UsageFromKind;
  role: string;
  isDraft: boolean;
  /** The referenced version of the subject, e.g. "Order v2.1". */
  target: string;
  label: string;
  /** Null when the referrer no longer exists (a ghost edge) — rendered as plain text. */
  href: string | null;
}

/** The rows of one lookup; `truncated` says more existed than were returned (a bounded lookup hit its limit). Not an array entry. */
export type UsageRowList = UsageRow[] & { readonly truncated: boolean };

export function usageRowList(rows: UsageRow[], truncated: boolean): UsageRowList {
  return Object.defineProperty(rows, "truncated", { value: truncated, enumerable: false }) as UsageRowList;
}

/**
 * What `listUsagesAction` sends to the browser. A server action's serializer keeps array entries only, so the `truncated` flag of a
 * `UsageRowList` would be lost on the wire: the action returns the two as plain properties of one object instead.
 */
export interface UsageList {
  rows: UsageRow[];
  truncated: boolean;
}

/** Rows an event's lookup returns at most (the service's `MAX_EVENT_REFERRERS`; a test keeps them equal): what a truncated list says it shows. */
export const USAGE_ROW_LIMIT = 50;

interface At {
  domainSlug: string | null;
  productSlug: string | null;
}
export interface UsageLookups {
  entityVersions: Record<string, { label: string; entity: At & { name: string; slug: string } }>;
  eventSpecs: Record<string, At & { id: string; name: string }>;
  eventSpecVersions: Record<string, { label: string; eventSpec: At & { id: string; name: string } }>;
  traits: Record<string, At & { id: string; name: string }>;
}

export interface ReferenceLike {
  id: string;
  fromKind: string;
  fromId: string;
  role: string;
  isDraft: boolean;
  toId: string;
}

/** The subject arrives from the browser: accept only the known shape with a non-empty string id. */
export function parseUsageSubject(value: unknown): Result<UsageSubject> {
  const bad = (message: string) => err({ code: "VALIDATION_ERROR" as const, message });
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("Usage subject must be an object");
  const v = value as { kind?: unknown; entityId?: unknown; eventId?: unknown };
  const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
  if (v.kind === "entity") return nonEmpty(v.entityId) ? ok({ kind: "entity", entityId: v.entityId }) : bad("entityId must be a non-empty string");
  if (v.kind === "event") return nonEmpty(v.eventId) ? ok({ kind: "event", eventId: v.eventId }) : bad("eventId must be a non-empty string");
  return bad('Usage subject kind must be "entity" or "event"');
}

const product = (a: At) => (a.domainSlug && a.productSlug ? { domainSlug: a.domainSlug, productSlug: a.productSlug } : null);

export function describeUsage(ref: ReferenceLike, lookups: UsageLookups, targetLabels: Record<string, string>): UsageRow {
  const base = { id: ref.id, fromKind: ref.fromKind as UsageFromKind, role: ref.role, isDraft: ref.isDraft, target: targetLabels[ref.toId] ?? ref.toId };
  // Defensive ghost edge: deleting an entity / event / trait removes the edges it sources (DB triggers), so a
  // referrer can only be missing for rows that predate those triggers or were written without a source row.
  const missing = (what: string): UsageRow => ({ ...base, label: `${what} ${ref.fromId} (deleted)`, href: null });
  switch (ref.fromKind) {
    case "ENTITY_VERSION": {
      const v = lookups.entityVersions[ref.fromId];
      if (!v) return missing("Entity version");
      // The entity page has no read-only `?version=` view yet (it always opens the live draft), so the row links to the entity
      // itself and keeps the version only as label text; a `{ version }` deep link would land on the draft and mislead.
      const href = assetHref({ kind: "entity", slug: v.entity.slug, domainSlug: v.entity.domainSlug, productSlug: v.entity.productSlug });
      return { ...base, label: `Entity ${v.entity.name} v${v.label}`, href };
    }
    case "EVENT_SPEC": {
      const e = lookups.eventSpecs[ref.fromId];
      const p = e && product(e);
      if (!e || !p) return missing("Event");
      return { ...base, label: `Event ${e.name} (draft)`, href: assetHref({ kind: "event", id: e.id, ...p }) };
    }
    case "EVENT_SPEC_VERSION": {
      const v = lookups.eventSpecVersions[ref.fromId];
      const p = v && product(v.eventSpec);
      if (!v || !p) return missing("Event version");
      return { ...base, label: `Event ${v.eventSpec.name} v${v.label}`, href: assetHref({ kind: "event", id: v.eventSpec.id, ...p }) };
    }
    case "TRAIT": {
      const t = lookups.traits[ref.fromId];
      if (!t) return missing("Trait");
      return { ...base, label: `Trait ${t.name}`, href: assetHref({ kind: "traits", domainSlug: t.domainSlug, productSlug: t.productSlug }) };
    }
    default:
      return missing(ref.fromKind);
  }
}
