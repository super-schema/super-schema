import { beforeEach, describe, expect, it, vi } from "vitest";

// The notification bell marks ONE notification read with `POST /api/v1/notifications?action=mark-read&id=<id>` (useNotificationCenter) and
// all of them with `?action=mark-all-read`. The route knew only the second, answered the first "Unknown action" (HTTP 500), and the read
// mark of a notification the user opened was never saved: it came back unread on the next load.
const authenticateRequest = vi.fn();
vi.mock("@/app/api/v1/middleware", () => ({ authenticateRequest: (...args: unknown[]) => authenticateRequest(...args) }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn() }));

const markAsRead = vi.fn();
const markAllAsRead = vi.fn();
vi.mock("@/services/notification.service", () => ({
  getNotificationsForUser: vi.fn(),
  getUnreadCount: vi.fn(),
  markAsRead: (...args: unknown[]) => markAsRead(...args),
  markAllAsRead: (...args: unknown[]) => markAllAsRead(...args),
}));

import { GET, POST } from "@/app/api/v1/notifications/route";
import { getNotificationsForUser, getUnreadCount } from "@/services/notification.service";
import { principalOf, roleless } from "../../helpers/access-mocks";

// Whoever is signed in has notifications, whatever role they hold: a user with NO role (not yet given access to any tenant) too.
const principal = principalOf([], { userId: "user-1" });
const context = expect.objectContaining({ userId: "user-1", assignments: [] });
const ROUTE = { params: Promise.resolve({}) };
const post = (query: string) => POST(new Request(`http://localhost/api/v1/notifications?${query}`, { method: "POST" }), ROUTE);
const get = (query = "") => GET(new Request(`http://localhost/api/v1/notifications${query}`), ROUTE);

describe("GET /api/v1/notifications: the signed-in user's own, a roleless user's included", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateRequest.mockResolvedValue({ authenticated: true, source: "session", principal: roleless("user-2"), tenantId: null });
    vi.mocked(getNotificationsForUser).mockResolvedValue({ success: true, data: { notifications: [], unreadCount: 0 } } as never);
    vi.mocked(getUnreadCount).mockResolvedValue({ success: true, data: 4 } as never);
  });

  it("lists the notifications of the caller's own id, with no role and no tenant (a user with no role yet is not refused)", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(getNotificationsForUser).toHaveBeenCalledWith("user-2", expect.anything(), expect.anything(), expect.objectContaining({ userId: "user-2" }));
  });

  it("the count only is the caller's too", async () => {
    const response = await get("?countOnly=true");
    expect(await response.json()).toEqual({ success: true, data: { unreadCount: 4 } });
    expect(getUnreadCount).toHaveBeenCalledWith("user-2", expect.anything());
  });

  it("without a credential the bell's poll gets a count of 0, the list a 401", async () => {
    authenticateRequest.mockResolvedValue({ authenticated: false });
    expect(await (await get("?countOnly=true")).json()).toEqual({ success: true, data: { unreadCount: 0 } });
    expect((await get()).status).toBe(401);
    expect(getNotificationsForUser).not.toHaveBeenCalled();
  });

  it("when who is calling cannot be looked up the poll answers an empty mailbox, not an error", async () => {
    authenticateRequest.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await get();
    expect(await response.json()).toEqual({ success: true, data: { unreadCount: 0, notifications: [], total: 0 } });
    spy.mockRestore();
  });
});

describe("POST /api/v1/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateRequest.mockResolvedValue({ authenticated: true, source: "session", principal, tenantId: null });
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
