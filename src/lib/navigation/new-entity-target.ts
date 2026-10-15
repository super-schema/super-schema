import { assetHref, ENTERPRISE_ROUTE_SEGMENT, TRAITS_SEGMENT } from "@/lib/navigation/asset-href";

/**
 * The new-entity page implied by the current `/schemas/...` path, or `null`
 * when the path names no placement (the domain list or a bare domain page), in
 * which case the caller lets the user pick a target.
 *
 * Anything under `/schemas/enterprise` is tenant-level, whatever its second
 * segment (`entities/<slug>`, `new`, ...); otherwise the first two segments are
 * the domain and product.
 */
export function newEntityHrefForPath(pathname: string): string | null {
  const match = pathname.match(/^\/schemas\/([^/]+)(?:\/([^/]+))?/);
  if (!match) return null;
  const [, first, second] = match;
  if (first === ENTERPRISE_ROUTE_SEGMENT) {
    return assetHref({ kind: "newEntity", domainSlug: null, productSlug: null });
  }
  // `/schemas/<domain>/traits/<id>` is a domain-level trait page, not a product named "traits" (that slug is reserved).
  if (!second || second === TRAITS_SEGMENT) return null;
  return assetHref({ kind: "newEntity", domainSlug: first, productSlug: second });
}
