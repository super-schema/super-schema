/**
 * Notification Service — Prisma-backed persistence.
 *
 * Provides CRUD operations for in-app notifications.
 * The Prisma `notification` model stores `entityId` as a string;
 * the full `entityRef` object is serialized as JSON into that column.
 */

import { prisma } from "@/lib/db";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import {
  CreateNotificationInputSchema,
  NotificationFilterSchema,
  PaginationSchema,
  type CreateNotificationInput,
  type Notification,
  type NotificationFilter,
  type Pagination,
  type EntityRef,
} from "@/types/schemas/notification";
import type { ServiceContext } from "@/types/service-context";
import type { Notification as PrismaNotification } from "@/generated/prisma/client";
import { domainSegment, productSegment } from "@/lib/entity-placement";

// ---------------------------------------------------------------------------
// Test helpers (kept for backward compat — delegate to Prisma)
// ---------------------------------------------------------------------------

/** Exposed for testing — resets the store. */
export async function _resetStore(): Promise<void> {
  await prisma.notification.deleteMany();
}

/** Exposed for testing — returns the raw store. */
export async function _getStore(): Promise<Notification[]> {
  const rows = await prisma.notification.findMany({
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toNotification);
}

// ---------------------------------------------------------------------------
// Prisma row → app Notification mapper
// ---------------------------------------------------------------------------

function toNotification(row: PrismaNotification): Notification {
  // entityRef is stored as JSON string in the entityId column
  let entityRef: EntityRef = { entityId: row.entityId ?? "" };
  if (row.entityId) {
    try {
      const parsed = JSON.parse(row.entityId);
      if (typeof parsed === "object" && parsed !== null && parsed.entityId) {
        entityRef = parsed as EntityRef;
      }
    } catch {
      // If it's not JSON, treat as a plain entityId
      entityRef = { entityId: row.entityId };
    }
  }

  return {
    id: row.id,
    userId: row.userId,
    type: row.type as Notification["type"],
    title: row.title,
    body: row.body,
    entityRef,
    read: row.read,
    createdAt: row.createdAt,
  };
}

async function enrichEntityRef(entityRef: EntityRef): Promise<EntityRef> {
  if (
    entityRef.domainSlug &&
    entityRef.productSlug &&
    entityRef.entitySlug &&
    (!entityRef.fieldId || entityRef.fieldSlug)
  ) {
    return entityRef;
  }

  const entity = await prisma.entity.findUnique({
    where: { id: entityRef.entityId },
    select: {
      slug: true,
      domain: { select: { slug: true } },
      product: { select: { slug: true } },
      fields: entityRef.fieldId
        ? {
            where: { id: entityRef.fieldId },
            select: { slug: true },
            take: 1,
          }
        : false,
    },
  });

  if (!entity) return entityRef;

  return {
    ...entityRef,
    domainSlug: entityRef.domainSlug ?? domainSegment(entity.domain),
    productSlug: entityRef.productSlug ?? productSegment(entity.product),
    entitySlug: entityRef.entitySlug ?? entity.slug,
    fieldSlug: entityRef.fieldId
      ? entityRef.fieldSlug ?? (entity.fields ? entity.fields[0]?.slug : undefined)
      : entityRef.fieldSlug,
  };
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function createNotification(
  input: CreateNotificationInput,
  _ctx: ServiceContext
): Promise<Result<Notification>> {
  const parsed = CreateNotificationInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Verify notification input fields.",
    });
  }

  const entityRef = await enrichEntityRef(parsed.data.entityRef);

  const row = await prisma.notification.create({
    data: {
      userId: parsed.data.userId,
      type: parsed.data.type as PrismaNotification["type"],
      title: parsed.data.title,
      body: parsed.data.body,
      entityId: JSON.stringify(entityRef),
      read: false,
    },
  });

  return ok(toNotification(row));
}

export async function getNotificationsForUser(
  userId: string,
  filters: NotificationFilter = {},
  pagination: Pagination = { page: 1, pageSize: 25 },
  _ctx: ServiceContext
): Promise<
  Result<{ notifications: Notification[]; unreadCount: number }>
> {
  const parsedFilters = NotificationFilterSchema.safeParse(filters);
  if (!parsedFilters.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsedFilters.error.issues[0].message,
    });
  }

  const parsedPagination = PaginationSchema.safeParse(pagination);
  if (!parsedPagination.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsedPagination.error.issues[0].message,
    });
  }

  const f = parsedFilters.data;
  const p = parsedPagination.data;

  // Build where clause
  const where: Record<string, unknown> = { userId };
  if (f.types && f.types.length > 0) {
    where.type = { in: f.types };
  }
  if (f.read !== undefined) {
    where.read = f.read;
  }

  const skip = (p.page - 1) * p.pageSize;

  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: where as Parameters<typeof prisma.notification.findMany>[0] extends { where?: infer W } ? W : never,
      orderBy: { createdAt: "desc" },
      skip,
      take: p.pageSize,
    }),
    prisma.notification.count({
      where: { userId, read: false },
    }),
  ]);

  return ok({
    notifications: rows.map(toNotification),
    unreadCount,
  });
}

export async function markAsRead(
  notificationId: string,
  ctx: ServiceContext
): Promise<Result<Notification>> {
  const row = await prisma.notification.findUnique({
    where: { id: notificationId },
  });

  if (!row) {
    return err({
      code: "NOT_FOUND",
      message: `Notification "${notificationId}" not found`,
    });
  }

  // Verify ownership
  if (row.userId !== ctx.userId) {
    return err({
      code: "FORBIDDEN",
      message: "You can only mark your own notifications as read",
    });
  }

  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { read: true },
  });

  return ok(toNotification(updated));
}

export async function markAllAsRead(
  userId: string,
  _ctx: ServiceContext
): Promise<Result<void>> {
  await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });

  return ok(undefined);
}

export async function getUnreadCount(
  userId: string,
  _ctx: ServiceContext
): Promise<Result<number>> {
  const count = await prisma.notification.count({
    where: { userId, read: false },
  });
  return ok(count);
}
