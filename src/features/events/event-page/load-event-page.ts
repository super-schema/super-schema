import { prisma } from "@/lib/db";
import { assetHref, normalizeBuilderSection, normalizeEventTab, type BuilderSection, type EventTab } from "@/lib/navigation/asset-href";
import { EVENT_SELECT, toEventDetail, type EventDetail } from "@/services/events/event.service";
import { productCrumbs } from "@/features/events/crumbs";
import type { LibraryTraitOption } from "@/features/events/builder/EventBuilder";
import { loadEntityOptions, loadTraitOptions, type LibraryTraitSource } from "@/features/events/load-options";
import { resolveProductRoute } from "@/features/events/route-scope";
import type { Crumb } from "@/features/events/shared/EventBreadcrumb";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";

export interface EventPageData {
  event: EventDetail;
  /** The route's product (tenant-scoped): what every draft call passes as the owner. */
  productId: string;
  domainSlug: string;
  productSlug: string;
  /** Every entity of the tenant, for the payload / headers / key pins. */
  entityOptions: EntityOption[];
  /** The library traits the event may use (tenant level and the event's own domain), message traits first: what "Add from library" offers. */
  libraryTraits: LibraryTraitOption[];
  crumbs: Crumb[];
  /** The product's Events tab. */
  listHref: string;
  initialTab: EventTab;
  initialSection: BuilderSection;
  /** `?item=`: the key of the builder item to select; null = none. */
  initialItem: string | null;
}

/**
 * "Enterprise" for a tenant-level trait, "Domain · Payments" for one of the event's domain (`loadTraitOptions` labels the owner).
 * The stored definition travels with the option: `spec` (what the instant code emits), `bundled` (built in, read-only) and
 * `properties` (the table of its inline message properties).
 */
function libraryOption(option: LibraryTraitSource, kind: LibraryTraitOption["kind"]): LibraryTraitOption {
  return {
    id: option.id, name: option.name, kind, level: option.ownerLabel === "Enterprise" ? "Enterprise" : `Domain · ${option.ownerLabel}`,
    spec: option.spec, bundled: option.bundled, properties: option.properties,
  };
}

/**
 * `null` means 404, for every reason alike (unknown route, unknown id, another tenant's event, another product's event, a stored
 * document that is not v2), so the page cannot be used to probe what exists. `getEvent` reads by id and trusts the row, so the
 * event is looked up here inside the route's tenant AND product: an event of a sibling product (even of the same domain) is
 * not this page's. A stored v1 (catalog-id) document is only readable by the old services: it is a 404 here, logged once under
 * its id (never its name).
 */
export async function loadEventPage(params: {
  domainSlug: string; productSlug: string; eventId: string; tab?: string; section?: string; item?: string;
}): Promise<EventPageData | null> {
  const route = await resolveProductRoute(params.domainSlug, params.productSlug);
  if (!route) return null;
  const row = await prisma.eventSpec.findFirst({
    where: { id: params.eventId, tenantId: route.tenantId, productId: route.product.id },
    select: EVENT_SELECT,
  });
  if (!row) return null;

  const detail = toEventDetail(row);
  if (!detail.success) {
    console.error(`[loadEventPage] stored document of event "${row.id}" is unreadable (${detail.error.code})`);
    return null;
  }

  // A library trait is usable from an event when it is tenant-level or of the event's own domain (never product-level: the service
  // refuses those), so the scope handed to the loader is the domain's, without the product.
  const libraryScope = { tenantId: route.tenantId, domainId: route.domain.id, productId: null };
  const [entityOptions, messageTraits, operationTraits] = await Promise.all([
    loadEntityOptions(route.tenantId),
    loadTraitOptions(libraryScope, "MESSAGE"),
    loadTraitOptions(libraryScope, "OPERATION"),
  ]);
  const libraryTraits = [
    ...messageTraits.map((t) => libraryOption(t, "MESSAGE")),
    ...operationTraits.map((t) => libraryOption(t, "OPERATION")),
  ];
  const listHref = assetHref({ kind: "events", domainSlug: route.domain.slug, productSlug: route.product.slug });
  return {
    event: detail.data,
    productId: route.product.id,
    domainSlug: route.domain.slug,
    productSlug: route.product.slug,
    entityOptions,
    libraryTraits,
    crumbs: productCrumbs(route, { label: "Events", href: listHref }, row.name),
    listHref,
    initialTab: normalizeEventTab(params.tab),
    initialSection: normalizeBuilderSection(params.section),
    initialItem: params.item ? params.item : null,
  };
}
