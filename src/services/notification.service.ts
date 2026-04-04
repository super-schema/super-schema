/**
 * Notification Service — In-memory store for MVP (no Prisma migration).
 *
 * Provides CRUD operations for in-app notifications.
 */

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
} from "@/types/schemas/notification";
import type { ServiceContext } from "@/types/service-context";

// ---------------------------------------------------------------------------
// In-memory store (MVP — replaces Prisma notification table)
// ---------------------------------------------------------------------------
let notifications: Notification[] = [];
let idCounter = 0;

function generateId(): string {
  idCounter++;
  return `notif_${idCounter}_${Date.now()}`;
}

/** Exposed for testing — resets the in-memory store. */
export function _resetStore(): void {
  notifications = [];
  idCounter = 0;
}

/** Exposed for testing — returns the raw store. */
export function _getStore(): Notification[] {
  return notifications;
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

  const notification: Notification = {
    id: generateId(),
    userId: parsed.data.userId,
    type: parsed.data.type,
    title: parsed.data.title,
    body: parsed.data.body,
    entityRef: parsed.data.entityRef,
    read: false,
    createdAt: new Date(),
  };

  notifications.push(notification);
  return ok(notification);
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

  let userNotifications = notifications.filter((n) => n.userId === userId);

  // Apply filters
  const f = parsedFilters.data;
  if (f.types && f.types.length > 0) {
    userNotifications = userNotifications.filter((n) =>
      f.types!.includes(n.type)
    );
  }
  if (f.read !== undefined) {
    userNotifications = userNotifications.filter((n) => n.read === f.read);
  }

  // Sort by createdAt desc
  userNotifications.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );

  // Unread count (always for the user, ignoring filters)
  const unreadCount = notifications.filter(
    (n) => n.userId === userId && !n.read
  ).length;

  // Paginate
  const p = parsedPagination.data;
  const start = (p.page - 1) * p.pageSize;
  const paginated = userNotifications.slice(start, start + p.pageSize);

  return ok({ notifications: paginated, unreadCount });
}

export async function markAsRead(
  notificationId: string,
  ctx: ServiceContext
): Promise<Result<Notification>> {
  const notification = notifications.find((n) => n.id === notificationId);

  if (!notification) {
    return err({
      code: "NOT_FOUND",
      message: `Notification "${notificationId}" not found`,
    });
  }

  // Verify ownership
  if (notification.userId !== ctx.userId) {
    return err({
      code: "FORBIDDEN",
      message: "You can only mark your own notifications as read",
    });
  }

  notification.read = true;
  return ok(notification);
}

export async function markAllAsRead(
  userId: string,
  _ctx: ServiceContext
): Promise<Result<void>> {
  notifications
    .filter((n) => n.userId === userId && !n.read)
    .forEach((n) => {
      n.read = true;
    });

  return ok(undefined);
}

export async function getUnreadCount(
  userId: string,
  _ctx: ServiceContext
): Promise<Result<number>> {
  const count = notifications.filter(
    (n) => n.userId === userId && !n.read
  ).length;
  return ok(count);
}
