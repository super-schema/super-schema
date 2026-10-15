// src/lib/events/usage.ts
import { assetHref } from "@/lib/navigation/asset-href";
import { ok, err, type Result } from "@/types/result";

export type UsageSubject = { kind: "entity"; entityId: string } | { kind: "message"; messageId: string };
export type UsageFromKind = "ENTITY_VERSION" | "MESSAGE" | "MESSAGE_VERSION" | "EVENT_SPEC" | "EVENT_SPEC_VERSION" | "TRAIT";

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

interface At {
  domainSlug: string | null;
  productSlug: string | null;
}
export interface UsageLookups {
  entityVersions: Record<string, { label: string; entity: At & { name: string; slug: string } }>;
  messages: Record<string, At & { id: string; name: string }>;
  messageVersions: Record<string, { label: string; message: At & { id: string; name: string } }>;
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

/** The subject arrives from the browser: accept only the two known shapes with a non-empty string id. */
export function parseUsageSubject(value: unknown): Result<UsageSubject> {
  const bad = (message: string) => err({ code: "VALIDATION_ERROR" as const, message });
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("Usage subject must be an object");
  const v = value as { kind?: unknown; entityId?: unknown; messageId?: unknown };
  const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
  if (v.kind === "entity") return nonEmpty(v.entityId) ? ok({ kind: "entity", entityId: v.entityId }) : bad("entityId must be a non-empty string");
  if (v.kind === "message") return nonEmpty(v.messageId) ? ok({ kind: "message", messageId: v.messageId }) : bad("messageId must be a non-empty string");
  return bad('Usage subject kind must be "entity" or "message"');
}

const product = (a: At) => (a.domainSlug && a.productSlug ? { domainSlug: a.domainSlug, productSlug: a.productSlug } : null);

type EventsSection = "specs" | "messages" | "channels";

/**
 * Messages and event specs only get detail routes with the Wave 5 pages, so until then (every link must work)
 * they point at the owning product's list tab. This is exactly the URL the Task 7 `events` AssetRef kind builds
 * (`?tab=events&section=<section>`); swap to `assetHref({ kind: "message" | "eventSpec", id, ...at })` once the
 * detail pages land and deep-link with `{ version }`.
 */
function eventsListHref(at: { domainSlug: string; productSlug: string }, section: EventsSection): string {
  return assetHref({ kind: "product", ...at }, { query: { tab: "events", section } });
}

export function describeUsage(ref: ReferenceLike, lookups: UsageLookups, targetLabels: Record<string, string>): UsageRow {
  const base = { id: ref.id, fromKind: ref.fromKind as UsageFromKind, role: ref.role, isDraft: ref.isDraft, target: targetLabels[ref.toId] ?? ref.toId };
  // Defensive ghost edge: deleting an entity / message / spec / trait removes the edges it sources (DB triggers), so a
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
    case "MESSAGE": {
      const m = lookups.messages[ref.fromId];
      const p = m && product(m);
      if (!m || !p) return missing("Message");
      return { ...base, label: `Message ${m.name} (draft)`, href: eventsListHref(p, "messages") };
    }
    case "MESSAGE_VERSION": {
      const v = lookups.messageVersions[ref.fromId];
      const p = v && product(v.message);
      if (!v || !p) return missing("Message version");
      return { ...base, label: `Message ${v.message.name} v${v.label}`, href: eventsListHref(p, "messages") };
    }
    case "EVENT_SPEC": {
      const s = lookups.eventSpecs[ref.fromId];
      const p = s && product(s);
      if (!s || !p) return missing("Event spec");
      return { ...base, label: `Event spec ${s.name} (draft)`, href: eventsListHref(p, "specs") };
    }
    case "EVENT_SPEC_VERSION": {
      const v = lookups.eventSpecVersions[ref.fromId];
      const p = v && product(v.eventSpec);
      if (!v || !p) return missing("Event spec version");
      return { ...base, label: `Event spec ${v.eventSpec.name} v${v.label}`, href: eventsListHref(p, "specs") };
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
