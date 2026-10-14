import { levelLabel } from "@/lib/levels";

/**
 * Display and URL fallbacks for entities that are not placed in a domain or
 * product. A tenant-level entity has `domain === null` and `product === null`;
 * readers that previously dereferenced `entity.domain.name` / `entity.product.slug`
 * resolve through these helpers instead of using non-null assertions.
 *
 * Tenant-level entities link to `/schemas/enterprise/entities/<slug>` (the
 * route itself arrives with the navigation work); the segments keep the
 * existing `/schemas/<domainSlug>/<productSlug>/<entity>` shape.
 */
export const TENANT_LEVEL_DOMAIN_SLUG = "enterprise";
export const TENANT_LEVEL_PRODUCT_SLUG = "entities";

/** Domain label for breadcrumbs and tables — "Enterprise" when tenant-level. */
export function domainLabel(domain: { name: string } | null | undefined): string {
  return domain?.name ?? levelLabel("TENANT");
}

/** First URL segment under /schemas — "enterprise" when tenant-level. */
export function domainSegment(domain: { slug: string } | null | undefined): string {
  return domain?.slug ?? TENANT_LEVEL_DOMAIN_SLUG;
}

/** Second URL segment under /schemas — "entities" when tenant-level. */
export function productSegment(product: { slug: string } | null | undefined): string {
  return product?.slug ?? TENANT_LEVEL_PRODUCT_SLUG;
}
