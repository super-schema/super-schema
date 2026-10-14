/**
 * The single source of truth for in-app URLs (spec §4.5). Every link —
 * sidebar, command palette, cards, breadcrumbs, cross-product references,
 * version deep links — goes through here.
 */
export type AssetRef =
  | { kind: "enterprise" }
  | { kind: "domain"; domainSlug: string }
  | { kind: "product"; domainSlug: string; productSlug: string }
  | { kind: "entity"; slug: string; domainSlug: string | null; productSlug: string | null }
  | { kind: "dataTypes"; domainSlug: string | null; productSlug: string | null }
  | { kind: "apis"; domainSlug: string; productSlug: string | null }
  | { kind: "traits"; domainSlug: string | null; productSlug: string | null }
  | { kind: "trait"; id: string; domainSlug: string | null; productSlug: string | null }
  | { kind: "message" | "channel" | "eventSpec"; id: string; domainSlug: string; productSlug: string }
  | { kind: "field"; entitySlug: string; fieldId: string; domainSlug: string | null; productSlug: string | null }
  | { kind: "newEntity"; domainSlug: string | null; productSlug: string | null };

const ROOT = "/schemas";
const ENTERPRISE = `${ROOT}/enterprise`;
const enc = encodeURIComponent;

function levelBase(domainSlug: string | null, productSlug: string | null): string {
  if (!domainSlug) return ENTERPRISE;
  if (!productSlug) return `${ROOT}/${enc(domainSlug)}`;
  return `${ROOT}/${enc(domainSlug)}/${enc(productSlug)}`;
}

function entityBase(slug: string, domainSlug: string | null, productSlug: string | null): string {
  if (!domainSlug || !productSlug) return `${ENTERPRISE}/entities/${enc(slug)}`;
  return `${levelBase(domainSlug, productSlug)}/${enc(slug)}`;
}

const EVENT_SEGMENT = { message: "messages", channel: "channels", eventSpec: "specs" } as const;

function path(ref: AssetRef): { path: string; query: Record<string, string> } {
  switch (ref.kind) {
    case "enterprise":
      return { path: ENTERPRISE, query: {} };
    case "domain":
      return { path: levelBase(ref.domainSlug, null), query: {} };
    case "product":
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: {} };
    case "entity":
      return { path: entityBase(ref.slug, ref.domainSlug, ref.productSlug), query: {} };
    case "field":
      return { path: `${entityBase(ref.entitySlug, ref.domainSlug, ref.productSlug)}/fields/${enc(ref.fieldId)}`, query: {} };
    case "dataTypes":
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: { tab: "data-types" } };
    case "apis":
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: { tab: "apis" } };
    case "traits":
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: { tab: "traits" } };
    case "trait":
      return { path: `${levelBase(ref.domainSlug, ref.productSlug)}/traits/${enc(ref.id)}`, query: {} };
    case "message":
    case "channel":
    case "eventSpec":
      return { path: `${levelBase(ref.domainSlug, ref.productSlug)}/${EVENT_SEGMENT[ref.kind]}/${enc(ref.id)}`, query: {} };
    case "newEntity":
      return { path: `${levelBase(ref.domainSlug, ref.productSlug)}/new`, query: {} };
  }
}

export function assetHref(ref: AssetRef, opts: { version?: string; query?: Record<string, string> } = {}): string {
  const { path: p, query } = path(ref);
  const qs = new URLSearchParams({ ...query, ...(opts.query ?? {}) });
  if (opts.version) qs.set("version", opts.version);
  const s = qs.toString();
  return s ? `${p}?${s}` : p;
}
