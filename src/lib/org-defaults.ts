import { prisma as defaultPrisma } from "@/lib/db";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";

/**
 * Org-hierarchy defaults: Tenant > Domain > Product > Entity.
 *
 * `tenantId` (on Domain) and `productId` (on Entity) are required, but much of
 * the current UI/API still works at the Domain/Entity level. Until tenant and
 * product selection is surfaced everywhere, new domains attach to a single
 * default tenant and new entities attach to their domain's default product.
 * These helpers resolve-or-create those defaults idempotently.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_TENANT_ID = "tenant_default";
export const DEFAULT_TENANT_SLUG = "default";
export const DEFAULT_PRODUCT_SLUG = "default";

/** Ensure the default tenant exists; returns its id. */
export async function ensureDefaultTenantId(db: Db = defaultPrisma): Promise<string> {
  await db.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: {},
    create: {
      id: DEFAULT_TENANT_ID,
      name: "Default Tenant",
      slug: DEFAULT_TENANT_SLUG,
      description: "Auto-created default tenant",
      isSystem: true,
    },
  });
  return DEFAULT_TENANT_ID;
}

/** Ensure a default product exists for the given domain; returns its id. */
export async function ensureDefaultProductId(
  domainId: string,
  db: Db = defaultPrisma
): Promise<string> {
  const existing = await db.product.findUnique({
    where: { slug_domainId: { slug: DEFAULT_PRODUCT_SLUG, domainId } },
  });
  if (existing) return existing.id;

  const created = await db.product.create({
    data: {
      domainId,
      name: "Default",
      slug: DEFAULT_PRODUCT_SLUG,
      description: "Auto-created default product",
      isSystem: true,
    },
  });
  return created.id;
}

/**
 * Resolve the tenant that owns a domain. Asset rows (entities, data types,
 * APIs) carry their own `tenantId` so tenant-level rows need no domain; domain-
 * and product-level creates inherit it from the parent domain.
 */
export async function getDomainTenantId(
  domainId: string,
  db: Db = defaultPrisma
): Promise<string> {
  const domain = await db.domain.findUniqueOrThrow({
    where: { id: domainId },
    select: { tenantId: true },
  });
  return domain.tenantId;
}
