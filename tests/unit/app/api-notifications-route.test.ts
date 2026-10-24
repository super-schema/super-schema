import { beforeEach, describe, expect, it, vi } from "vitest";

// The notification bell marks ONE notification read with `POST /api/v1/notifications?action=mark-read&id=<id>` (useNotificationCenter) and
// all of them with `?action=mark-all-read`. The route knew only the second, answered the first "Unknown action" (HTTP 500), and the read
// mark of a notification the user opened was never saved: it came back unread on the next load.
const authenticateRequest = vi.fn();
vi.mock("@/app/api/v1/middleware", () => ({ authenticateRequest: (...args: unknown[]) => authenticateRequest(...args) }));

const markAsRead = vi.fn();
const markAllAsRead = vi.fn();
vi.mock("@/services/notification.service", () => ({
  getNotificationsForUser: vi.fn(),
  getUnreadCount: vi.fn(),
  markAsRead: (...args: unknown[]) => markAsRead(...args),
  markAllAsRead: (...args: unknown[]) => markAllAsRead(...args),
}));

import { POST } from "@/app/api/v1/notifications/route";

const context = { userId: "user-1", userRole: "VIEWER", prisma: {} };
const post = (query: string) => POST(new Request(`http://localhost/api/v1/notifications?${query}`, { method: "POST" }));

describe("POST /api/v1/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateRequest.mockResolvedValue({ authenticated: true, context });
    markAsRead.mockResolvedValue({ success: true, data: {} });
    markAllAsRead.mockResolvedValue({ success: true, data: undefined });
  });

  it("mark-read marks the one notification of the signed-in user and answers success", async () => {
    const response = await post("action=mark-read&id=note-7");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { marked: true } });
    expect(markAsRead).toHaveBeenCalledWith("note-7", context);
    expect(markAllAsRead).not.toHaveBeenCalled();
  });

  it("mark-read without an id is refused, and nothing is marked", async () => {
    const response = await post("action=mark-read");

    expect(response.status).toBe(400);
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it("mark-read passes the service's refusal on (somebody else's notification is FORBIDDEN, an unknown one NOT_FOUND)", async () => {
    markAsRead.mockResolvedValue({ success: false, error: { code: "FORBIDDEN", message: "You can only mark your own notifications as read" } });
    const forbidden = await post("action=mark-read&id=note-of-another-user");
    expect(forbidden.status).toBe(403);

    markAsRead.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: 'Notification "x" not found' } });
    const missing = await post("action=mark-read&id=x");
    expect(missing.status).toBe(404);
  });

  it("mark-all-read still marks every notification of the user", async () => {
    const response = await post("action=mark-all-read");

    expect(response.status).toBe(200);
    expect(markAllAsRead).toHaveBeenCalledWith("user-1", context);
  });

  it("a request without a session is answered 401 and marks nothing", async () => {
    authenticateRequest.mockResolvedValue({ authenticated: false });
    const response = await post("action=mark-read&id=note-7");

    expect(response.status).toBe(401);
    expect(markAsRead).not.toHaveBeenCalled();
  });
});
