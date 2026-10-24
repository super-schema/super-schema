/**
 * The single source of truth for in-app URLs (spec §4.5). Every link —
 * sidebar, command palette, cards, breadcrumbs, cross-product references,
 * version deep links — goes through here.
 */
/** URL segment of library trait detail pages (`<domain>/traits/<id>`, `enterprise/traits/<id>`). */
export const TRAITS_SEGMENT = "traits";

/** URL segment of the self-contained Event page (`<product>/events/<id>`). */
export const EVENT_PAGE_SEGMENT = "events";

/** Tabs of the Event page, in the order the page shows them. */
export const EVENT_TABS = ["design", "docs", "versions", "used-by"] as const;
export type EventTab = (typeof EVENT_TABS)[number];
const DEFAULT_EVENT_TAB: EventTab = "design";
/**
 * Tab names still found in bookmarks and old links: the old Event Spec page's tabs, and the slice-1 "preview" tab, which is
 * the rendered documentation and is called "docs" now (the live code lives in the right-hand Detail Panel).
 */
const EVENT_TAB_ALIASES: ReadonlyMap<string, EventTab> = new Map<string, EventTab>([
  ["editor", "design"],
  ["preview", "docs"],
  ["document", "docs"],
  ["diagnostics", "docs"],
]);

/** The Event page tab named by `?tab=`: a known tab or an old alias; a missing or unknown value falls back to "design". */
export function normalizeEventTab(value: string | null | undefined): EventTab {
  if (typeof value !== "string") return DEFAULT_EVENT_TAB;
  if ((EVENT_TABS as readonly string[]).includes(value)) return value as EventTab;
  return EVENT_TAB_ALIASES.get(value) ?? DEFAULT_EVENT_TAB;
}

/**
 * The tab a key press on the tab list moves to (roving tabindex): ArrowRight / ArrowLeft wrap around, Home and End jump to the
 * ends; any other key is not navigation (null).
 */
export function nextEventTab(current: EventTab, key: string): EventTab | null {
  const at = EVENT_TABS.indexOf(current);
  if (key === "ArrowRight") return EVENT_TABS[(at + 1) % EVENT_TABS.length];
  if (key === "ArrowLeft") return EVENT_TABS[(at - 1 + EVENT_TABS.length) % EVENT_TABS.length];
  if (key === "Home") return EVENT_TABS[0];
  if (key === "End") return EVENT_TABS[EVENT_TABS.length - 1];
  return null;
}

/** Sections of the Design tab's builder, in outline order. A value that is none of these (an old link) falls back to "metadata". */
export const BUILDER_SECTIONS = ["metadata", "servers", "channels", "messages", "operations", "traits", "advanced"] as const;
export type BuilderSection = (typeof BUILDER_SECTIONS)[number];
const DEFAULT_BUILDER_SECTION: BuilderSection = "metadata";

/** The builder section named by `?section=`; a missing or unknown value falls back to "metadata". */
export function normalizeBuilderSection(value: string | null | undefined): BuilderSection {
  return typeof value === "string" && (BUILDER_SECTIONS as readonly string[]).includes(value) ? (value as BuilderSection) : DEFAULT_BUILDER_SECTION;
}

export type AssetRef =
  | { kind: "enterprise" }
  | { kind: "domain"; domainSlug: string }
  | { kind: "product"; domainSlug: string; productSlug: string }
  | { kind: "entity"; slug: string; domainSlug: string | null; productSlug: string | null }
  | { kind: "dataTypes"; domainSlug: string | null; productSlug: string | null }
  | { kind: "apis"; domainSlug: string; productSlug: string | null }
  | { kind: "traits"; domainSlug: string | null; productSlug: string | null }
  | { kind: "trait"; id: string; domainSlug: string | null }
  | { kind: "event"; id: string; domainSlug: string; productSlug: string }
  | { kind: "field"; entitySlug: string; fieldId: string; domainSlug: string | null; productSlug: string | null }
  | { kind: "events"; domainSlug: string; productSlug: string }
  | { kind: "newEntity"; domainSlug: string | null; productSlug: string | null };

/**
 * URL segments of the tenant-level (Enterprise) scope. A route that receives
 * `[domainSlug]=ENTERPRISE_ROUTE_SEGMENT` and `[productSlug]=ENTERPRISE_ENTITIES_SEGMENT`
 * is a tenant-level entity URL. They are exported so route code that must detect
 * that shape reads the literals from here, never re-declares them.
 */
export const ENTERPRISE_ROUTE_SEGMENT = "enterprise";
export const ENTERPRISE_ENTITIES_SEGMENT = "entities";

const ROOT = "/schemas";
const ENTERPRISE = `${ROOT}/${ENTERPRISE_ROUTE_SEGMENT}`;
const enc = encodeURIComponent;

function levelBase(domainSlug: string | null, productSlug: string | null): string {
  if (!domainSlug) return ENTERPRISE;
  if (!productSlug) return `${ROOT}/${enc(domainSlug)}`;
  return `${ROOT}/${enc(domainSlug)}/${enc(productSlug)}`;
}

function entityBase(slug: string, domainSlug: string | null, productSlug: string | null): string {
  if (!domainSlug || !productSlug) return `${ENTERPRISE}/${ENTERPRISE_ENTITIES_SEGMENT}/${enc(slug)}`;
  return `${levelBase(domainSlug, productSlug)}/${enc(slug)}`;
}

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
      return { path: `${levelBase(ref.domainSlug, null)}/${TRAITS_SEGMENT}/${enc(ref.id)}`, query: {} };
    case "event":
      return { path: `${levelBase(ref.domainSlug, ref.productSlug)}/${EVENT_PAGE_SEGMENT}/${enc(ref.id)}`, query: {} };
    case "events":
      // The Events tab is one flat list of the product's events.
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: { tab: "events" } };
    case "newEntity":
      return { path: `${levelBase(ref.domainSlug, ref.productSlug)}/new`, query: {} };
  }
}

/** The search params of a Next page (`searchParams`): a key that appears twice is a list, a key without a value is `undefined`. */
export type QueryParams = Record<string, string | readonly string[] | undefined>;

export interface AssetHrefOptions {
  version?: string;
  /** Extra query params, written in the order given; every value of a list is written, `undefined` and an empty list are left out. */
  query?: QueryParams;
  /** `event` refs only (ignored for every other kind): the page tab, the builder section and the selected item key. A default or empty value is omitted. */
  tab?: EventTab;
  section?: BuilderSection;
  item?: string;
}

/** The Event page's own params, in URL order; the default tab / section and an empty item add nothing. */
function eventQuery(opts: AssetHrefOptions): Record<string, string> {
  const query: Record<string, string> = {};
  if (opts.tab && opts.tab !== DEFAULT_EVENT_TAB) query.tab = opts.tab;
  if (opts.section && opts.section !== DEFAULT_BUILDER_SECTION) query.section = opts.section;
  if (opts.item) query.item = opts.item;
  return query;
}

export function assetHref(ref: AssetRef, opts: AssetHrefOptions = {}): string {
  const { path: p, query } = path(ref);
  const qs = new URLSearchParams();
  const merged: QueryParams = { ...query, ...(ref.kind === "event" ? eventQuery(opts) : {}), ...(opts.query ?? {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    for (const item of typeof value === "string" ? [value] : value) qs.append(key, item);
  }
  if (opts.version) qs.set("version", opts.version);
  const s = qs.toString();
  return s ? `${p}?${s}` : p;
}
