// @vitest-environment node
/**
 * Defence in depth behind the middleware (tests/unit/middleware.test.ts): the dashboard layout itself asks Auth.js for the session
 * and sends a visitor without one to /login, so a page of the dashboard is never rendered for a request that got past the middleware
 * (a misconfigured matcher, a future change of the middleware) without a session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/components/layout/DashboardClientShell", () => ({ DashboardClientShell: () => null }));

import DashboardLayout from "@/app/(dashboard)/layout";

beforeEach(() => vi.clearAllMocks());

describe("the dashboard layout", () => {
  it("redirects to /login when there is no session, and renders nothing of the dashboard", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(DashboardLayout({ children: "secret" })).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("redirects when the session has no user", async () => {
    mocks.auth.mockResolvedValue({ expires: "2999-01-01" });
    await expect(DashboardLayout({ children: "secret" })).rejects.toThrow("NEXT_REDIRECT /login");
  });

  it("renders the shell around the page for a session with a user", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "u1", email: "a@b.c" }, expires: "2999-01-01" });
    const element = await DashboardLayout({ children: "page" });
    expect(element).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
