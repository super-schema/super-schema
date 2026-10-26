// @vitest-environment node
/**
 * /invite/[token] and /reset/[token] render their form ONLY for a live link (known, unused, unexpired), and ONE generic page for everything else:
 * the HTML for "no such token", "malformed", "expired" and "used" is the same bytes, and says nothing of the address, so the page cannot tell a
 * visitor which it was. The form for a live invitation shows the invited e-mail read-only and carries the token in a hidden field.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findValidInvitation: vi.fn(), findValidResetToken: vi.fn() }));
vi.mock("@/lib/auth/tokens", () => ({ findValidInvitation: mocks.findValidInvitation, findValidResetToken: mocks.findValidResetToken }));
// The forms import their server actions, which reach for Auth.js and the database: the pages are what is under test.
vi.mock("@/app/(auth)/invite/[token]/actions", () => ({ acceptInvitationAction: vi.fn() }));
vi.mock("@/app/(auth)/reset/[token]/actions", () => ({ consumeResetAction: vi.fn() }));

import InvitePage, { dynamic as inviteDynamic } from "@/app/(auth)/invite/[token]/page";
import ResetPage, { dynamic as resetDynamic } from "@/app/(auth)/reset/[token]/page";
import { INVALID_LINK_MESSAGE } from "@/lib/auth/messages";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const render = async (page: (props: { params: Promise<{ token: string }> }) => Promise<React.JSX.Element>, token: string) =>
  renderToStaticMarkup(await page({ params: Promise.resolve({ token }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findValidInvitation.mockResolvedValue(null);
  mocks.findValidResetToken.mockResolvedValue(null);
});

describe("pages that depend on the database right now", () => {
  it("are never rendered ahead of time", () => {
    expect(inviteDynamic).toBe("force-dynamic");
    expect(resetDynamic).toBe("force-dynamic");
  });
});

describe("/invite/[token]", () => {
  it("renders the form for a live invitation: the invited e-mail (read-only), the token in a hidden field, a password and its confirmation", async () => {
    mocks.findValidInvitation.mockResolvedValue({ email: "invited@example.test" });

    const html = await render(InvitePage, TOKEN);

    expect(mocks.findValidInvitation).toHaveBeenCalledWith(TOKEN);
    expect(html).toContain('data-testid="invite-form"');
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="token"[^>]*value="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"/);
    expect(html).toMatch(/<input[^>]*data-testid="invite-email"[^>]*/);
    expect(html).toContain('value="invited@example.test"');
    expect(html).toMatch(/<input[^>]*data-testid="invite-email"[^>]*readOnly=""|<input[^>]*readOnly=""[^>]*data-testid="invite-email"/);
    // The e-mail is not a field that is submitted: no name, so the form cannot change who the account is for.
    expect(/<input[^>]*name="email"/.test(html)).toBe(false);
    expect(html).toContain('name="password"');
    expect(html).toContain('name="confirmPassword"');
    expect(html).not.toContain('data-testid="invalid-link"');
  });

  it("renders the one generic page when the link is not live: the same bytes whatever the address was, and nothing of the address in them", async () => {
    const pages = await Promise.all([TOKEN, "short", "x".repeat(500), "%2e%2e", ""].map((token) => render(InvitePage, token)));

    for (const html of pages) expect(html).toBe(pages[0]);
    expect(pages[0]).toContain('data-testid="invalid-link"');
    expect(pages[0]).toContain(INVALID_LINK_MESSAGE);
    expect(pages[0]).not.toContain("<form");
    expect(pages[0]).not.toContain("<input");
    expect(pages[0]).not.toContain(TOKEN);
  });
});

describe("/reset/[token]", () => {
  it("renders the form for a live link: the token in a hidden field, a password and its confirmation, and no account named", async () => {
    mocks.findValidResetToken.mockResolvedValue({ valid: true });

    const html = await render(ResetPage, TOKEN);

    expect(mocks.findValidResetToken).toHaveBeenCalledWith(TOKEN);
    expect(html).toContain('data-testid="reset-form"');
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="token"[^>]*value="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"/);
    expect(html).toContain('name="password"');
    expect(html).toContain('name="confirmPassword"');
    expect(/<input[^>]*name="email"/.test(html)).toBe(false);
    expect(html).not.toContain('data-testid="invalid-link"');
  });

  it("renders the one generic page when the link is not live, the same bytes as the invitation's, nothing of the address in them", async () => {
    const pages = await Promise.all([TOKEN, "short", "x".repeat(500), ""].map((token) => render(ResetPage, token)));
    for (const html of pages) expect(html).toBe(pages[0]);
    expect(pages[0]).toBe(await render(InvitePage, TOKEN));
    expect(pages[0]).toContain(INVALID_LINK_MESSAGE);
    expect(pages[0]).not.toContain("<form");
    expect(pages[0]).not.toContain(TOKEN);
  });
});
