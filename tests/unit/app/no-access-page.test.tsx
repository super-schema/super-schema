// @vitest-environment node
/**
 * The "no access yet" screen: a signed-in user who may access no tenant lands here (no role assigned yet, or a disabled account: the page says the
 * same thing for both, so it tells nobody which). It needs a session and no role. It shows who is signed in (the e-mail of the session, which is the
 * viewer's own), says who to ask, offers a way to check again and to sign out, and leaks nothing: no tenant, no administrator, no reason.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  }),
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import NoAccessPage from "@/app/(auth)/no-access/page";
import { NO_ACCESS_PATH } from "@/lib/access/no-tenant-access";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "u1", email: "me@example.test" } });
});

const render = async () => renderToStaticMarkup(await NoAccessPage());

describe("/no-access", () => {
  it("is the path the dashboard sends a user with no tenant access to", () => {
    expect(NO_ACCESS_PATH).toBe("/no-access");
  });

  it("explains that no role has been assigned, and who to ask", async () => {
    const html = await render();
    expect(html).toContain('data-testid="no-access"');
    expect(html).toContain("No access yet");
    expect(html).toContain("no role has been assigned");
    expect(html).toMatch(/ask an administrator|person who invited you/i);
  });

  it("shows the e-mail of the signed-in user, escaped", async () => {
    expect(await render()).toContain("me@example.test");
    mocks.auth.mockResolvedValue({ user: { id: "u1", email: '<img src=x onerror="alert(1)">@example.test' } });
    const html = await render();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("offers to check again (the dashboard decides) and to sign out", async () => {
    const html = await render();
    expect(html).toMatch(/<a[^>]*href="\/schemas"[^>]*>[^<]*(check again|try again)/i);
    expect(html).toMatch(/<button[^>]*data-testid="no-access-sign-out"[^>]*>\s*Sign out\s*<\/button>/);
  });

  it("says the same thing to a disabled account, a roleless one and a stale session: no reason, no tenant, no administrator named", async () => {
    // What a person reads: the markup without its tags (class names such as `disabled:opacity-50` are not words on the page).
    const words = (await render()).replace(/<[^>]*>/g, " ");
    expect(words).not.toMatch(/disabled|suspended|deactivated|locked|banned/i);
    expect(words).not.toMatch(/tenant|domain|admin@|@admin/i);
  });

  it("needs a session: a visitor without one is sent to the login page (the middleware does it first; this is the page's own door)", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(NoAccessPage()).rejects.toMatchObject({ redirectTo: "/login" });
  });

  it("does NOT send a session whose user has no id or e-mail to /login: the dashboard sends such a session here (a stale one), and /login would bounce it back (a loop)", async () => {
    mocks.auth.mockResolvedValue({ user: {} });
    expect(await render()).toContain('data-testid="no-access"');
  });

  it("copes with a session that has no e-mail (it still offers the way out)", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "u1" } });
    const html = await render();
    expect(html).toContain('data-testid="no-access-sign-out"');
    expect(html).not.toContain("undefined");
  });
});
