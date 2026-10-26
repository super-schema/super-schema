// @vitest-environment node
/**
 * /register under the three modes: `closed` says registration is closed (no form), `invite` shows the generic dead-link card unless it is given a
 * live invitation token (then it continues at /invite/<token>), `open` shows the form (no identity-provider button, whatever is configured: nobody signs up through a provider).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findValidInvitation: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  }),
}));
vi.mock("@/lib/auth/tokens", () => ({ findValidInvitation: mocks.findValidInvitation }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/(auth)/register/actions", () => ({ registerAction: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

import RegisterPage, { dynamic } from "@/app/(auth)/register/page";
import { INVALID_LINK_MESSAGE, REGISTRATION_CLOSED_MESSAGE } from "@/lib/auth/messages";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

async function render(search: { token?: string | string[] } = {}) {
  try {
    return { html: renderToStaticMarkup(await RegisterPage({ searchParams: Promise.resolve(search) })) };
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return { redirectTo: (error as Error & { redirectTo: string }).redirectTo };
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("AUTH_PROVIDERS", "");
  mocks.findValidInvitation.mockResolvedValue(null);
});

describe("the register page", () => {
  it("is rendered for each request: the mode is the server's environment now", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("closed: says registration is closed, with no form", async () => {
    vi.stubEnv("AUTH_REGISTRATION", "closed");
    const result = (await render()) as { html: string };
    expect(result.html).toContain('data-testid="registration-closed"');
    expect(result.html).toContain(REGISTRATION_CLOSED_MESSAGE);
    expect(result.html).not.toContain("<form");
    expect(result.html).not.toContain("<input");
  });

  describe("invite (the default)", () => {
    it.each([
      ["no token", {}],
      ["an empty token", { token: "" }],
      ["a dead token", { token: TOKEN }],
      ["a repeated token parameter", { token: [TOKEN, TOKEN] }],
    ])("%s: the one generic dead-link card, no form, the same bytes for every reason, nothing of the address in it", async (_name, search) => {
      vi.stubEnv("AUTH_REGISTRATION", "");
      const result = (await render(search)) as { html: string };
      const baseline = (await render({})) as { html: string };
      expect(result.html).toBe(baseline.html);
      expect(result.html).toContain('data-testid="invalid-link"');
      expect(result.html).toContain(INVALID_LINK_MESSAGE);
      expect(result.html).not.toContain("<form");
      expect(result.html).not.toContain(TOKEN);
    });

    it("a live token continues at /invite/<token>", async () => {
      vi.stubEnv("AUTH_REGISTRATION", "invite");
      mocks.findValidInvitation.mockResolvedValue({ email: "invited@example.test" });
      expect(await render({ token: TOKEN })).toEqual({ redirectTo: `/invite/${TOKEN}` });
      expect(mocks.findValidInvitation).toHaveBeenCalledWith(TOKEN);
    });

    it("does not look a token up when there is none", async () => {
      await render({});
      expect(mocks.findValidInvitation).not.toHaveBeenCalled();
    });
  });

  describe("open", () => {
    beforeEach(() => vi.stubEnv("AUTH_REGISTRATION", "open"));

    it("shows the form and no provider button by default", async () => {
      const result = (await render()) as { html: string };
      expect(result.html).toContain('data-testid="register-form"');
      expect(result.html).not.toMatch(/continue with/i);
      expect(mocks.findValidInvitation).not.toHaveBeenCalled();
    });

    it("shows no provider button when providers ARE configured: they sign in people who already have an account, they make none", async () => {
      vi.stubEnv("AUTH_PROVIDERS", "okta");
      vi.stubEnv("AUTH_PROVIDER_OKTA_CLIENT_ID", "client");
      vi.stubEnv("AUTH_PROVIDER_OKTA_CLIENT_SECRET", "secret");
      vi.stubEnv("AUTH_PROVIDER_OKTA_ISSUER", "https://acme.okta.test");
      const result = (await render()) as { html: string };
      expect(result.html).toContain('data-testid="register-form"');
      expect(result.html).not.toMatch(/okta|continue with|provider-button/i);
    });
  });
});
