/**
 * GET  /api/v1/notifications — List notifications for the authenticated user.
 * POST /api/v1/notifications/mark-all-read — Mark all as read (via query param ?action=mark-all-read).
 *
 * Query params: types (comma-separated), read (boolean), page, pageSize
 *
 * Notifications are the signed-in user's own, whatever their roles (`notification.own`: a user with no role yet still has them). The API key has
 * no mailbox: it is no user, so its list is empty.
 */

import { withApiAuth } from "@/lib/access/api";
import { apiSuccess, apiError, apiServerError } from "@/app/api/v1/error-handler";
import { isUsableId, optionalParam, queryProblem, unusableIdNotFound } from "@/app/api/v1/request";
import {
  getNotificationsForUser,
  markAllAsRead,
  markAsRead,
  getUnreadCount,
} from "@/services/notification.service";
import type { NotificationFilter } from "@/types/schemas/notification";

export const GET = withApiAuth(
  "notification.own",
  async (request, api) => {
    try {
      const url = new URL(request.url);
      const bad = queryProblem(url);
      if (bad) return bad;

      // Check if requesting unread count only
      if (url.searchParams.get("countOnly") === "true") {
        const countResult = await getUnreadCount(api.ctx.userId, api.ctx);
        if (!countResult.success) return apiError(countResult.error);
        return apiSuccess({ unreadCount: countResult.data });
      }

      // Every optional parameter: an empty value is no value (`?read=` is no filter, `?page=` is the first page).
      const typesParam = optionalParam(url, "types");
      const readParam = optionalParam(url, "read");
      const page = parseInt(optionalParam(url, "page") ?? "1", 10);
      const pageSize = parseInt(optionalParam(url, "pageSize") ?? "25", 10);

      const filters: NotificationFilter = {
        types: typesParam ? typesParam.split(",") as NotificationFilter["types"] : undefined,
        read: readParam !== undefined ? readParam === "true" : undefined,
      };

      const result = await getNotificationsForUser(api.ctx.userId, filters, { page, pageSize }, api.ctx);

      if (!result.success) return apiError(result.error);

      return apiSuccess(result.data);
    } catch (e) {
      console.error("GET /api/v1/notifications error:", e);
      return apiServerError();
    }
  },
  {
    // The bell polls: without a credential it asks for the count and gets 0, not a 401 (the list itself still needs one).
    unauthenticated: (request) => (new URL(request.url).searchParams.get("countOnly") === "true" ? apiSuccess({ unreadCount: 0 }) : null),
    // Looking up who is calling failed (the database): the poll answers an empty mailbox rather than an error.
    authFailure: () => apiSuccess({ unreadCount: 0, notifications: [], total: 0 }),
    // The REST API's limits: a request that does not authenticate counts against its address (the anonymous count answer above is not counted: it is
    // a constant 0, never a refusal), the signed-in bell against its user.
    rateLimit: true,
  }
);

export const POST = withApiAuth("notification.own", async (request, api) => {
  try {
    const url = new URL(request.url);
    const bad = queryProblem(url);
    if (bad) return bad;
    const action = optionalParam(url, "action");

    if (action === "mark-read") {
      const id = optionalParam(url, "id");
      if (!id) return apiError({ code: "VALIDATION_ERROR", message: "Notification id is required" });
      if (!isUsableId(id)) return unusableIdNotFound("notification", id);
      const result = await markAsRead(id, api.ctx);
      if (!result.success) return apiError(result.error);
      return apiSuccess({ marked: true });
    }

    if (action === "mark-all-read") {
      const result = await markAllAsRead(api.ctx.userId, api.ctx);
      if (!result.success) return apiError(result.error);
      return apiSuccess({ marked: true });
    }

    // An action the route does not have is the caller's mistake, not a failure of the server.
    return apiError({
      code: "VALIDATION_ERROR",
      message: "Unknown action",
      suggestedFix: "Use ?action=mark-read&id=<notification id>, or ?action=mark-all-read.",
    });
  } catch (e) {
    console.error("POST /api/v1/notifications error:", e);
    return apiServerError();
  }
}, { rateLimit: true });
