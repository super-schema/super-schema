import { prisma } from "@/lib/db";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { assetHref } from "@/lib/navigation/asset-href";
import type { EventSpecDetail, EventVersionSummary } from "@/lib/events/types";
import { findEventSpecsWithCatalogDrift, SPEC_SELECT, toEventSpecDetail } from "@/services/events/event-spec.service";
import { toEventVersionSummary, VERSION_SUMMARY_SELECT } from "@/services/events/version-summary";
import { productCrumbs } from "@/features/events/crumbs";
import {
  loadChannelOptions, loadMessageRefOptions, loadTraitOptions, ownerLabel,
  type ChannelOption, type MessageRefOption, type TraitOption,
} from "@/features/events/load-options";
import { resolveProductRoute } from "@/features/events/route-scope";
import type { Crumb } from "@/features/events/shared/EventBreadcrumb";
import { normalizeSpecTab, type SpecTab } from "./spec-tabs";
import { parseVersionParam } from "./version-param";

export interface EventSpecPageData {
  /** For another product's spec (`owner` set) this is a stub: name, type and latest label only — never its draft. */
  spec: EventSpecDetail;
  /** The route's product (tenant-scoped): what every draft call passes as the owner. */
  productId: string;
  domainSlug: string;
  productSlug: string;
  crumbs: Crumb[];
  channelOptions: ChannelOption[];
  messageOptions: MessageRefOption[];
  operationTraits: TraitOption[];
  versions: EventVersionSummary[];
  /** `?version=` of a published version; null = the draft. */
  viewingVersion: string | null;
  initialTab: SpecTab;
  /** Set when the spec belongs to another product of the tenant: published versions only, never editable here. */
  owner: { label: string; href: string } | null;
}

const PAGE_SELECT = {
  ...SPEC_SELECT,
  product: { select: { id: true, name: true, slug: true, domain: { select: { id: true, name: true, slug: true } } } },
} as const;

/**
 * Another product's draft (document with its channel / message / trait ids, flags, placement) never reaches this page: the stub is an
 * allow-list of the row's public fields — the draft is not even parsed — so a field added to `EventSpecDetail` later cannot leak.
 */
function publishedOnly(row: { id: string; name: string; specType: string; tenantId: string; latestVersion: { major: number; minor: number } | null }): EventSpecDetail {
  return {
    id: row.id,
    name: row.name,
    specType: row.specType,
    document: { info: { title: row.name }, servers: [], operations: [] },
    latestVersionLabel: row.latestVersion ? formatVersionLabel(row.latestVersion) : null,
    hasUnpublishedChanges: false,
    tenantId: row.tenantId,
    domainId: null,
    productId: null,
  };
}

/**
 * `null` means 404, for every reason alike (unknown route, unknown id, another tenant's spec, malformed or unknown `?version`),
 * so the page cannot be used to probe what exists. `getEventSpec` / `emitEventSpec` read by id and trust the row, so the spec is
 * looked up here inside the route's tenant first. A spec of another product of the tenant is readable only as a published
 * version (`?version` is mandatory there), with the draft replaced by a stub before anything is serialized to the browser.
 */
export async function loadEventSpecPage(params: {
  domainSlug: string; productSlug: string; specId: string; version?: string; tab?: string;
}): Promise<EventSpecPageData | null> {
  // The label is validated before any read: a malformed one answers exactly like an unknown id.
  const requested = params.version ? parseVersionParam(params.version) : null;
  if (params.version && !requested) return null;

  const route = await resolveProductRoute(params.domainSlug, params.productSlug);
  if (!route) return null;
  const row = await prisma.eventSpec.findFirst({ where: { id: params.specId, tenantId: route.tenantId }, select: PAGE_SELECT });
  if (!row) return null;

  const ownerProduct = row.productId === route.product.id ? null : row.product;
  if (row.productId !== route.product.id && (!ownerProduct || !requested)) return null;

  const versions = (await prisma.eventSpecVersion.findMany({ where: { eventSpecId: row.id }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT })).map(toEventVersionSummary);
  let viewingVersion: string | null = null;
  if (requested) {
    const match = versions.find((v) => v.major === requested.major && v.minor === requested.minor);
    if (!match) return null;
    viewingVersion = match.label;
  }

  // The pickers only feed the draft editor, which a published version (or another product's spec) never shows.
  const scope = { tenantId: route.tenantId, domainId: route.domain.id, productId: route.product.id };
  const [channelOptions, messageOptions, operationTraits] = viewingVersion
    ? [[], [], []] as [ChannelOption[], MessageRefOption[], TraitOption[]]
    : await Promise.all([
        loadChannelOptions(route.tenantId, route.product.id),
        loadMessageRefOptions(route.tenantId, route.product.id),
        loadTraitOptions(scope, "OPERATION"),
      ]);
  const shared = {
    productId: route.product.id,
    domainSlug: route.domain.slug,
    productSlug: route.product.slug,
    channelOptions,
    messageOptions,
    operationTraits,
    versions,
    viewingVersion,
    initialTab: normalizeSpecTab(params.tab ?? null, viewingVersion),
  };

  if (!ownerProduct) {
    const detail = toEventSpecDetail(row);
    if (!detail.success) {
      console.error(`[loadEventSpecPage] stored document of event spec "${row.id}" is unreadable (${detail.error.code})`);
      return null;
    }
    const listHref = assetHref({ kind: "events", domainSlug: route.domain.slug, productSlug: route.product.slug, section: "specs" });
    // D8: the badge also reads live Channel / Trait drift (R78), which the stored flag never sees. Compared against the frozen
    // copies only (no rendering), and only when the flag is not already set.
    const drifted = row.latestVersion && !detail.data.hasUnpublishedChanges
      ? (await findEventSpecsWithCatalogDrift(prisma, route.tenantId, [row.id])).has(row.id)
      : false;
    const spec = drifted ? { ...detail.data, hasUnpublishedChanges: true } : detail.data;
    return { ...shared, spec, crumbs: productCrumbs(route, { label: "Event Specs", href: listHref }, row.name), owner: null };
  }

  // Crumbs and the owner link name the owning product; version links keep the reader on this read-only page.
  const at = { domainSlug: ownerProduct.domain.slug, productSlug: ownerProduct.slug };
  const listHref = assetHref({ kind: "events", ...at, section: "specs" });
  return {
    ...shared,
    spec: publishedOnly(row),
    crumbs: productCrumbs({ tenantId: route.tenantId, tenantSlug: route.tenantSlug, domain: ownerProduct.domain, product: ownerProduct }, { label: "Event Specs", href: listHref }, row.name),
    owner: { label: ownerLabel({ domain: ownerProduct.domain, product: ownerProduct }), href: assetHref({ kind: "eventSpec", id: row.id, ...at }, { version: viewingVersion ?? undefined }) },
  };
}
