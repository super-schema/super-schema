import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { Product, ProductTier } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { generateSlug, isReservedProductRouteSlug } from "@/lib/slug";
import { combineBlockers, EVENTS_ASSET_COUNT_SELECT, productDeleteBlocker } from "@/lib/product-deletion";
import { crossProductPinBlocker } from "@/lib/events/cross-product-pins";
import { findCrossProductPins } from "@/services/events/delete-guards";
import { eventsInUseError, findCrossProductEventRefs, type EventReferrer } from "@/services/events/event-guards";
import { guardRead } from "@/services/events/service-guards";
import { normalizeProductContacts } from "@/lib/product-contacts";
import type { ProductContactsInput } from "@/lib/product-contacts";

export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  ownerTeam: string | null;
  isSystem: boolean;
  tier: {
    id: string;
    name: string;
    displayColor: string;
    bgColor: string;
    textColor: string;
  } | null;
  entityCount: number;
  updatedAt: Date;
}

/**
 * `engineeringLead` / `manager` / `teamEmails` are mailbox text (`jane@acme.com` or `Jane Doe <jane@acme.com>`); the service
 * validates them (VALIDATION_ERROR with `details.fieldErrors`) and saves the canonical form. See `@/lib/product-contacts`.
 */
export interface CreateProductInput extends ProductContactsInput {
  domainId: string;
  name: string;
  description?: string;
  tierId?: string | null;
  ownerTeam?: string | null;
}

export interface UpdateProductInput extends ProductContactsInput {
  name?: string;
  description?: string;
  tierId?: string | null;
  ownerTeam?: string | null;
}

export async function getProductTiers(
  ctx: ServiceContext
): Promise<Result<ProductTier[]>> {
  const tiers = await ctx.prisma.productTier.findMany({
    orderBy: { sortOrder: "asc" },
  });
  return ok(tiers);
}

export async function getProductsByDomain(
  domainId: string,
  ctx: ServiceContext
): Promise<Result<ProductListItem[]>> {
  const products = await ctx.prisma.product.findMany({
    where: { domainId },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: {
      tier: true,
      _count: { select: { entities: true } },
    },
  });

  return ok(products.map(toListItem));
}

function toListItem(p: {
  id: string;
  name: string;
  slug: string;
  description: string;
  ownerTeam: string | null;
  isSystem: boolean;
  updatedAt: Date;
  tier: ProductTier | null;
  _count: { entities: number };
}): ProductListItem {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    ownerTeam: p.ownerTeam,
    isSystem: p.isSystem,
    tier: p.tier
      ? {
          id: p.tier.id,
          name: p.tier.name,
          displayColor: p.tier.displayColor,
          bgColor: p.tier.bgColor,
          textColor: p.tier.textColor,
        }
      : null,
    entityCount: p._count.entities,
    updatedAt: p.updatedAt,
  };
}

export async function createProduct(
  input: CreateProductInput,
  ctx: ServiceContext
): Promise<Result<Product>> {
  const name = input.name?.trim();
  if (!name) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Product name is required",
      suggestedFix: "Enter a product name.",
    });
  }
  if (name.length > 64) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Product name must be 64 characters or less",
    });
  }

  const slug = generateSlug(name);
  if (isReservedProductRouteSlug(slug)) {
    return err({
      code: "VALIDATION_ERROR",
      message: `"${slug}" is reserved for a domain-level utility page.`,
      suggestedFix: "Choose a different product name.",
    });
  }

  const contacts = normalizeProductContacts(input);
  if (!contacts.success) return contacts;

  try {
    const product = await withAudit({
      action: "CREATE",
      entityType: "Product",
      entityId: "pending",
      userId: ctx.userId,
      fn: async () =>
        prisma.product.create({
          data: {
            domainId: input.domainId,
            name,
            slug,
            description: input.description ?? "",
            tierId: input.tierId ?? null,
            ownerTeam: input.ownerTeam ?? null,
            engineeringLead: contacts.data.engineeringLead ?? null,
            manager: contacts.data.manager ?? null,
            teamEmails: contacts.data.teamEmails ?? [],
          },
        }),
    });
    return ok(product);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return err({
        code: "DUPLICATE",
        message: `A product named "${name}" already exists in this domain`,
        suggestedFix: "Choose a different product name.",
      });
    }
    throw e;
  }
}

export async function updateProduct(
  id: string,
  input: UpdateProductInput,
  ctx: ServiceContext
): Promise<Result<Product>> {
  const existing = await ctx.prisma.product.findUnique({ where: { id } });
  if (!existing) {
    return err({ code: "NOT_FOUND", message: `Product "${id}" not found` });
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      return err({ code: "VALIDATION_ERROR", message: "Product name is required" });
    }
    const slug = generateSlug(name);
    if (isReservedProductRouteSlug(slug)) {
      return err({
        code: "VALIDATION_ERROR",
        message: `"${slug}" is reserved for a domain-level utility page.`,
        suggestedFix: "Choose a different product name.",
      });
    }
    data.name = name;
    data.slug = slug;
  }
  if (input.description !== undefined) data.description = input.description;
  if (input.tierId !== undefined) data.tierId = input.tierId;
  if (input.ownerTeam !== undefined) data.ownerTeam = input.ownerTeam;

  const contacts = normalizeProductContacts(input);
  if (!contacts.success) return contacts;
  Object.assign(data, contacts.data);

  try {
    const product = await withAudit({
      action: "UPDATE",
      entityType: "Product",
      entityId: id,
      userId: ctx.userId,
      fn: async () => prisma.product.update({ where: { id }, data }),
    });
    return ok(product);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return err({
        code: "DUPLICATE",
        message: "A product with that name already exists in this domain",
      });
    }
    throw e;
  }
}

export async function deleteProduct(
  id: string,
  ctx: ServiceContext
): Promise<Result<{ id: string }>> {
  const existing = await ctx.prisma.product.findUnique({
    where: { id },
    include: {
      domain: { select: { tenantId: true } },
      _count: {
        select: {
          entities: true,
          sharedEnums: true,
          customScalars: true,
          unionTypes: true,
          services: true,
          ...EVENTS_ASSET_COUNT_SELECT,
        },
      },
    },
  });
  if (!existing) {
    return err({ code: "NOT_FOUND", message: `Product "${id}" not found` });
  }
  if (existing.isSystem) {
    return err({
      code: "VALIDATION_ERROR",
      message: "System products cannot be deleted",
    });
  }
  // Entities, product-level Data Types / APIs and Events assets (channels, messages, traits, event specs) all
  // cascade with the product (FK ON DELETE CASCADE), so any of them blocks the delete. Events assets also block
  // while a published event spec of ANOTHER product still pins or froze one of them (immutable versions) — that
  // reason is reported together with the content counts, naming the specs and their products.
  const pins = await findCrossProductPins(ctx.prisma, {
    kind: "product",
    productId: id,
    tenantId: existing.domain.tenantId,
  });
  // Events of OTHER products that reference a published version of one of this product's events (self-contained events:
  // edges, no FK) are reported in the same message. A product that owns no event spec has no version to reference, so the
  // lookup is skipped; a failing read is a DB_ERROR Result.
  const eventRefs =
    existing._count.eventSpecs === 0
      ? ok<EventReferrer[]>([])
      : await guardRead(async () => ok(await findCrossProductEventRefs(ctx.prisma, { kind: "product", productId: id, tenantId: existing.domain.tenantId })));
  if (!eventRefs.success) return eventRefs;
  const eventsBlocked = eventsInUseError("Product", existing.name, eventRefs.data);
  const contentBlocker = combineBlockers([productDeleteBlocker(existing._count), crossProductPinBlocker(pins)]);
  const blocker = combineBlockers([contentBlocker, eventsBlocked?.message]);
  if (blocker) {
    return err({
      // The long-standing blockers keep their code; event references alone are an IN_USE.
      code: contentBlocker ? "VALIDATION_ERROR" : "IN_USE",
      message: blocker,
      ...((pins.length > 0 || eventsBlocked) && {
        details: { ...(pins.length > 0 && { eventSpecs: pins }), ...(eventsBlocked && { events: eventsBlocked.details }) },
      }),
      suggestedFix:
        "Remove or move the product's entities, Data Types, APIs and Events assets (channels, messages, traits, event specs), then delete the product.",
    });
  }

  await withAudit({
    action: "DELETE",
    entityType: "Product",
    entityId: id,
    userId: ctx.userId,
    fn: async () => prisma.product.delete({ where: { id } }),
  });
  return ok({ id });
}
