/**
 * A notification is clickable only when it resolves to a real entity URL.
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "@/components/custom/NotificationCenter/NotificationCenter";
import { getNotificationNavigationUrl } from "@/components/custom/NotificationCenter/useNotificationCenter";
import type { NotificationItemData } from "@/components/custom/NotificationCenter/NotificationCenter.types";
import { BEFORE_NAVIGATE_EVENT, beforeNavigateHref } from "@/lib/navigation/before-navigate";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  markAsRead: vi.fn(async () => {}),
  setOpen: vi.fn(),
  notifications: [] as NotificationItemData[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/custom/NotificationCenter/useNotificationCenter", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/custom/NotificationCenter/useNotificationCenter")>();
  return {
    ...original,
    useNotificationCenter: () => ({
      unreadCount: mocks.notifications.length,
      open: true,
      setOpen: mocks.setOpen,
      loading: false,
      groupedNotifications: [{ label: "Changes", types: ["CHANGE_COMPLETE"], notifications: mocks.notifications }],
      markAsRead: mocks.markAsRead,
      markAllAsRead: vi.fn(),
      getNavigationUrl: original.getNotificationNavigationUrl,
    }),
  };
});

const notification = (id: string, entityRef: NotificationItemData["entityRef"]): NotificationItemData => ({
  id,
  userId: "u1",
  type: "CHANGE_COMPLETE",
  title: `Title ${id}`,
  body: "Body",
  entityRef,
  read: false,
  createdAt: new Date(),
});

describe("NotificationCenter navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notifications = [
      notification("resolved", { entityId: "e1", entitySlug: "customer", domainSlug: null, productSlug: null }),
      notification("unresolved", { entityId: "e2" }),
    ];
  });
  afterEach(() => cleanup());

  it("sanity: only the resolved notification has a URL", () => {
    expect(getNotificationNavigationUrl(mocks.notifications[0])).toBe("/schemas/enterprise/entities/customer");
    expect(getNotificationNavigationUrl(mocks.notifications[1])).toBeNull();
  });

  it("navigates and marks read when a resolved notification is clicked", async () => {
    render(<NotificationCenter />);
    fireEvent.click(screen.getByTestId("notification-item-resolved"));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/schemas/enterprise/entities/customer"));
    expect(mocks.markAsRead).toHaveBeenCalledWith("resolved");
  });

  describe("a page with unsaved work can veto the navigation", () => {
    const asked: Array<string | null> = [];
    let veto = false;
    const listener = (e: Event) => {
      asked.push(beforeNavigateHref(e));
      if (veto) e.preventDefault();
    };
    beforeEach(() => {
      asked.length = 0;
    });
    afterEach(() => document.removeEventListener(BEFORE_NAVIGATE_EVENT, listener));
    const listenFor = (vetoes: boolean) => {
      veto = vetoes;
      document.addEventListener(BEFORE_NAVIGATE_EVENT, listener);
    };

    it("asks the page where the notification goes, then navigates when nothing is vetoed", async () => {
      listenFor(false);
      render(<NotificationCenter />);
      fireEvent.click(screen.getByTestId("notification-item-resolved"));

      await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/schemas/enterprise/entities/customer"));
      expect(asked).toEqual(["/schemas/enterprise/entities/customer"]);
      expect(mocks.markAsRead).toHaveBeenCalledWith("resolved");
    });

    it("does not navigate, and does not mark it read, when the page vetoes; the panel still closes", async () => {
      listenFor(true);
      render(<NotificationCenter />);
      fireEvent.click(screen.getByTestId("notification-item-resolved"));

      await waitFor(() => expect(mocks.setOpen).toHaveBeenCalledWith(false));
      expect(asked).toEqual(["/schemas/enterprise/entities/customer"]);
      expect(mocks.push).not.toHaveBeenCalled();
      expect(mocks.markAsRead).not.toHaveBeenCalled(); // the user did not go there
    });
  });

  it("renders an unresolved notification as a non-clickable item that never navigates", () => {
    render(<NotificationCenter />);
    const item = screen.getByTestId("notification-item-unresolved");

    expect(item.tagName).not.toBe("BUTTON");
    expect(screen.getByText("Title unresolved")).toBeTruthy();
    fireEvent.click(item);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.markAsRead).not.toHaveBeenCalled();
  });
});
