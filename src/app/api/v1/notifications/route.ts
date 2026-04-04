/**
 * GET  /api/v1/notifications — List notifications for the authenticated user.
 * POST /api/v1/notifications/mark-all-read — Mark all as read (via query param ?action=mark-all-read).
 *
 * Query params: types (comma-separated), read (boolean), page, pageSize
 */

import { authenticateRequest } from "@/app/api/v1/middleware";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiServerError,
} from "@/app/api/v1/error-handler";
import {
  getNotificationsForUser,
  markAllAsRead,
  getUnreadCount,
} from "@/services/notification.service";

export async function GET(request: Request) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const url = new URL(request.url);

    // Check if requesting unread count only
    if (url.searchParams.get("countOnly") === "true") {
      const countResult = await getUnreadCount(
        authResult.context.userId,
        authResult.context
      );
      if (!countResult.success) return apiError(countResult.error);
      return apiSuccess({ unreadCount: countResult.data });
    }

    const typesParam = url.searchParams.get("types");
    const readParam = url.searchParams.get("read");
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);
    const pageSize = parseInt(url.searchParams.get("pageSize") ?? "25", 10);

    const filters = {
      types: typesParam ? typesParam.split(",") : undefined,
      read: readParam !== null ? readParam === "true" : undefined,
    };

    const result = await getNotificationsForUser(
      authResult.context.userId,
      filters,
      { page, pageSize },
      authResult.context
    );

    if (!result.success) return apiError(result.error);

    return apiSuccess(result.data);
  } catch (e) {
    console.error("GET /api/v1/notifications error:", e);
    return apiServerError();
  }
}

export async function POST(request: Request) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    if (action === "mark-all-read") {
      const result = await markAllAsRead(
        authResult.context.userId,
        authResult.context
      );
      if (!result.success) return apiError(result.error);
      return apiSuccess({ marked: true });
    }

    return apiServerError("Unknown action");
  } catch (e) {
    console.error("POST /api/v1/notifications error:", e);
    return apiServerError();
  }
}
