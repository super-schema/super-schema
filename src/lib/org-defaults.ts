import { prisma as defaultPrisma } from "@/lib/db";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { ensureBundledTraits } from "@/services/events/bundled-traits.service";

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

/** A full client can open the transaction `ensureBundledTraits` needs; a transaction client cannot nest one. */
const isFullClient = (db: Db): db is PrismaClient => "$transaction" in db;

export const DEFAULT_TENANT_ID = "tenant_default";
export const DEFAULT_TENANT_SLUG = "default";
export const DEFAULT_PRODUCT_SLUG = "default";

/**
 * Ensure the default tenant exists; returns its id. A tenant this call creates also gets the built-in message properties
 * (`ensureBundledTraits`). That step needs a full client (it opens its own transaction), so it is skipped for a transaction client,
 * and it never fails the call: a tenant is usable without them, and `npm run dev` / `db:deploy` install them for every tenant.
 */
export async function ensureDefaultTenantId(db: Db = defaultPrisma): Promise<string> {
  const existing = await db.tenant.findUnique({ where: { id: DEFAULT_TENANT_ID }, select: { id: true } });
  if (existing) return DEFAULT_TENANT_ID;
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
  if (isFullClient(db)) {
    try {
      const installed = await ensureBundledTraits(db, DEFAULT_TENANT_ID);
      if (!installed.success) console.error(`[org-defaults] built-in message properties not installed (${installed.error.code})`);
    } catch (e: unknown) {
      console.error("[org-defaults] built-in message properties not installed", e);
    }
  }
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
