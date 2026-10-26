// src/features/events/route-scope.ts
import { prisma } from "@/lib/db";
import { can, canListDomain, canListProduct } from "@/lib/access";
import { isNoTenantAccess } from "@/lib/access/no-tenant-access";
import { getPrincipal, type Principal } from "@/lib/access/principal";
import { getActiveTenantId } from "@/lib/active-tenant";
import type { ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";

interface Named {
  id: string;
  name: string;
  slug: string;
}

export interface ProductRoute {
  tenantId: string;
  tenantSlug: string;
  domain: Named;
  product: Named;
}

/**
 * Who is looking and at which tenant: the principal and the tenant in view, or null for a caller who may reach none (no role, a disabled user, a stale
 * session: `NoTenantAccess`), which every route below answers as a missing one (null = a 404), never as an error. Any other failure is not hidden.
 */
async function viewer(): Promise<{ principal: Principal; tenantId: string } | null> {
  const principal = await getPrincipal();
  if (!principal) return null;
  try {
    return { principal, tenantId: await getActiveTenantId(principal) };
  } catch (e: unknown) {
    if (isNoTenantAccess(e)) return null;
    throw e;
  }
}

/**
 * Product addressed by `/schemas/<domainSlug>/<productSlug>/…` inside the active tenant, or null: the tenant in view's, and a product a role of the caller covers
 * (`canListProduct`: its own scope, its domain's, the tenant's or a platform role). A product of another tenant, one no role of theirs covers and one that does
 * not exist are the same null, so the events and traits pages under it answer the same 404.
 */
export async function resolveProductRoute(domainSlug: string, productSlug: string): Promise<ProductRoute | null> {
  const seen = await viewer();
  if (!seen) return null;
  const { principal, tenantId } = seen;
  const product = await prisma.product.findFirst({
    where: { slug: productSlug, domain: { slug: domainSlug, tenantId } },
    select: {
      id: true, name: true, slug: true,
      domain: { select: { id: true, name: true, slug: true, tenant: { select: { id: true, slug: true } } } },
    },
  });
  if (!product) return null;
  if (!canListProduct(principal.assignments, { tenantId, domainId: product.domain.id, productId: product.id })) return null;
  return {
    tenantId: product.domain.tenant.id,
    tenantSlug: product.domain.tenant.slug,
    domain: { id: product.domain.id, name: product.domain.name, slug: product.domain.slug },
    product: { id: product.id, name: product.name, slug: product.slug },
  };
}

export interface LevelRoute {
  scope: LevelScope;
  target: ScopeTarget;
  tenantSlug: string;
  domain: Named | null;
  product: Named | null;
}

/**
 * Enterprise (both null), domain (productSlug null) or product level, inside the active tenant, and only a level the caller's roles cover: the Enterprise level
 * is the tenant itself (a tenant-wide or platform role: trait.read over the tenant), a domain one is a domain a role covers (canListDomain), a product one is a
 * product a role covers. Anything else is null (a 404).
 */
export async function resolveLevelRoute(domainSlug: string | null, productSlug: string | null): Promise<LevelRoute | null> {
  if (domainSlug && productSlug) {
    const route = await resolveProductRoute(domainSlug, productSlug);
    if (!route) return null;
    return {
      scope: { tenantId: route.tenantId, domainId: route.domain.id, productId: route.product.id },
      target: { level: "PRODUCT", productId: route.product.id },
      tenantSlug: route.tenantSlug,
      domain: route.domain,
      product: route.product,
    };
  }
  const seen = await viewer();
  if (!seen) return null;
  const { principal, tenantId } = seen;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true } });
  if (!tenant) return null;
  if (!domainSlug) {
    if (!can(principal.assignments, "trait.read", { tenantId })) return null;
    return {
      scope: { tenantId, domainId: null, productId: null },
      target: { level: "TENANT", tenantId },
      tenantSlug: tenant.slug,
      domain: null,
      product: null,
    };
  }
  const domain = await prisma.domain.findFirst({ where: { slug: domainSlug, tenantId }, select: { id: true, name: true, slug: true } });
  if (!domain || !canListDomain(principal.assignments, { tenantId, domainId: domain.id })) return null;
  return {
    scope: { tenantId, domainId: domain.id, productId: null },
    target: { level: "DOMAIN", domainId: domain.id },
    tenantSlug: tenant.slug,
    domain,
    product: null,
  };
}
