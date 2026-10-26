import { prisma } from "@/lib/db";
import { can, readableWhere } from "@/lib/access";
import { getPrincipal } from "@/lib/access/principal";
import type { ScopeTarget } from "@/lib/asset-scope";
import { assetHref } from "@/lib/navigation/asset-href";
import type { TraitDetail } from "@/lib/events/types";
import { TRAIT_SELECT, toTraitDetail } from "@/services/events/trait.service";
import { PROPERTIES_TAB_LABEL } from "@/features/events/builder/labels";
import { levelCrumbs } from "@/features/events/crumbs";
import { loadEntityOptions } from "@/features/events/load-options";
import { resolveLevelRoute } from "@/features/events/route-scope";
import type { Crumb } from "@/features/events/shared/EventBreadcrumb";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";

export interface TraitPageData {
  trait: TraitDetail;
  owner: ScopeTarget;
  crumbs: Crumb[];
  listHref: string;
  entityOptions: EntityOption[];
}

/**
 * A trait is only reachable under its own level's URL (assetHref); anything else 404s — another level, another product, another
 * tenant and an unknown id all return the same null (no existence oracle). `getTrait` is an unscoped by-id read, so the read here
 * is scoped by the route's tenant, domain and product, never by id alone.
 */
export async function loadTraitPage(params: { domainSlug: string | null; productSlug: string | null; traitId: string }): Promise<TraitPageData | null> {
  if (!params.domainSlug && params.productSlug) return null; // no such URL: a product always sits under its domain
  const route = await resolveLevelRoute(params.domainSlug, params.productSlug);
  if (!route) return null;
  // A trait is read by a role that covers the LEVEL it lives at (the Enterprise: the tenant as a whole; a domain: that domain), not merely one of its products.
  const principal = await getPrincipal();
  if (!principal || !can(principal.assignments, "trait.read", route.scope)) return null;
  const row = await prisma.trait.findFirst({
    where: { id: params.traitId, tenantId: route.scope.tenantId, domainId: route.scope.domainId, productId: route.scope.productId },
    select: TRAIT_SELECT,
  });
  if (!row) return null;
  const listHref = assetHref({ kind: "traits", domainSlug: route.domain?.slug ?? null, productSlug: route.product?.slug ?? null });
  return {
    trait: toTraitDetail(row),
    owner: route.target,
    listHref,
    crumbs: levelCrumbs(route, { label: PROPERTIES_TAB_LABEL, href: listHref }, row.name),
    entityOptions: await loadEntityOptions(route.scope.tenantId, readableWhere(principal.assignments, "entity.read", route.scope.tenantId)),
  };
}
