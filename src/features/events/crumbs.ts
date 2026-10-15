import { assetHref } from "@/lib/navigation/asset-href";
import type { LevelRoute, ProductRoute } from "./route-scope";
import type { Crumb } from "./shared/EventBreadcrumb";

/** Domains › <Domain> › <Product> › <section> › <current> — every link via assetHref. */
export function productCrumbs(route: ProductRoute, section: Crumb, current: string): Crumb[] {
  return [
    { label: "Domains", href: "/schemas" },
    { label: route.domain.name, href: assetHref({ kind: "domain", domainSlug: route.domain.slug }) },
    { label: route.product.name, href: assetHref({ kind: "product", domainSlug: route.domain.slug, productSlug: route.product.slug }) },
    section,
    { label: current },
  ];
}

/** Same for a trait at any level (Enterprise › …, Domains › <Domain> › …, or the product chain). */
export function levelCrumbs(route: LevelRoute, section: Crumb, current: string): Crumb[] {
  if (route.domain && route.product) {
    return productCrumbs({ tenantId: route.scope.tenantId, tenantSlug: route.tenantSlug, domain: route.domain, product: route.product }, section, current);
  }
  if (route.domain) {
    return [
      { label: "Domains", href: "/schemas" },
      { label: route.domain.name, href: assetHref({ kind: "domain", domainSlug: route.domain.slug }) },
      section,
      { label: current },
    ];
  }
  return [{ label: "Enterprise", href: assetHref({ kind: "enterprise" }) }, section, { label: current }];
}
