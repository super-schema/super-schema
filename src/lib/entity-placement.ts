import { levelLabel } from "@/lib/levels";

/**
 * Display fallback for entities that are not placed in a domain or product. A
 * tenant-level entity has `domain === null` and `product === null`; readers that
 * previously dereferenced `entity.domain.name` resolve through this helper
 * instead of using a non-null assertion.
 *
 * URLs are NOT built here: carry `domainSlug: string | null` /
 * `productSlug: string | null` (null for tenant-level) and link with
 * `assetHref` from `@/lib/navigation/asset-href`, which owns the tenant-level
 * URL scheme.
 */

/** Domain label for breadcrumbs and tables — "Enterprise" when tenant-level. */
export function domainLabel(domain: { name: string } | null | undefined): string {
  return domain?.name ?? levelLabel("TENANT");
}
