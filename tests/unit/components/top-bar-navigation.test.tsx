/**
 * @vitest-environment jsdom
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TopBar } from "@/components/layout/TopBar";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { email: "owner@example.com" } } }),
  signOut: vi.fn(),
}));

vi.mock("@/hooks/useCommandPalette", () => ({
  useCommandPalette: () => ({ open: vi.fn() }),
}));

vi.mock("@/lib/platform", () => ({
  useModKey: () => "Cmd",
}));

vi.mock("@/components/custom/NotificationCenter", () => ({
  NotificationCenter: () => <button type="button">Notifications</button>,
}));

vi.mock("@/components/layout/TenantSwitcher", () => ({
  TenantSwitcher: () => <div data-testid="tenant-switcher" />,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    render,
    ...props
  }: {
    children?: ReactNode;
    render?: ReactNode;
  }) => render ?? <button type="button" {...props}>{children}</button>,
}));

describe("TopBar navigation", () => {
  afterEach(cleanup);

  it("routes the profile menu item instead of rendering an inert item", () => {
    render(<TopBar />);

    const profileLink = screen.getByRole("link", { name: "Profile" });
    expect(profileLink.getAttribute("href")).toBe("/admin/settings");
  });

  it("shows the Admin link only when the person has an admin right (off by default, personal settings stay in the user menu)", () => {
    render(<TopBar />);
    expect(screen.queryByTestId("topbar-admin")).toBeNull();
    expect(screen.queryByRole("link", { name: "Administration" })).toBeNull();
    cleanup();

    render(<TopBar showAdmin />);
    expect(screen.getByRole("link", { name: "Administration" }).getAttribute("href")).toBe("/admin");
    expect(screen.getByRole("link", { name: "Profile" }).getAttribute("href")).toBe("/admin/settings");
  });
});
