// @vitest-environment jsdom
/**
 * What the login page offers depends on the server: the Google button only when GOOGLE_CLIENT_ID is set (it is absent by default), the "Create one"
 * link only when registration is open, and the notices of a redirect (`/login?notice=...`) are a fixed list that never shows what the address says.
 * The failure message is one text for every reason (the server-side half is tests/unit/lib/auth/credentials.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: (...args: unknown[]) => mocks.signIn(...args) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import LoginPage, { dynamic } from "@/app/(auth)/login/page";
import { LoginForm } from "@/app/(auth)/login/login-form";
import { INVALID_CREDENTIALS_MESSAGE, LOGIN_NOTICES } from "@/lib/auth/messages";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GOOGLE_CLIENT_ID", "");
  vi.stubEnv("AUTH_REGISTRATION", "");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  window.history.pushState({}, "", "/");
});

const googleButton = () => screen.queryByRole("button", { name: /continue with google/i });

describe("the login page (what the server tells the form)", () => {
  it("is rendered for each request, not baked into a build: it reads the environment", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("has NO Google button by default (GOOGLE_CLIENT_ID is not set), and no divider that would introduce it", () => {
    render(<LoginPage />);
    expect(googleButton()).toBeNull();
    expect(screen.queryByText(/or continue with email/i)).toBeNull();
    expect(screen.getByTestId("login-form")).toBeTruthy();
  });

  it("has the Google button when GOOGLE_CLIENT_ID is set", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "1234.apps.googleusercontent.com");
    render(<LoginPage />);
    expect(googleButton()).not.toBeNull();
  });

  it("has no Google button when GOOGLE_CLIENT_ID is empty or blank", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "   ");
    render(<LoginPage />);
    expect(googleButton()).toBeNull();
  });

  it("offers 'Create one' only when registration is open (it is invite-only by default, so no link to a page that would say so)", () => {
    for (const [mode, shown] of [["", false], ["invite", false], ["closed", false], ["open", true]] as const) {
      vi.stubEnv("AUTH_REGISTRATION", mode);
      render(<LoginPage />);
      expect(screen.queryByTestId("login-register-link") !== null, `AUTH_REGISTRATION=${JSON.stringify(mode)}`).toBe(shown);
      cleanup();
    }
  });
});

describe("the login form's props are the whole story", () => {
  it("shows the Google button for googleEnabled, and not without it", () => {
    render(<LoginForm />);
    expect(googleButton()).toBeNull();
    expect(screen.queryByTestId("login-register-link")).toBeNull();
    cleanup();
    render(<LoginForm googleEnabled registrationOpen />);
    expect(googleButton()).not.toBeNull();
    expect(screen.getByTestId("login-register-link").getAttribute("href")).toBe("/register");
  });
});

describe("notices after a redirect", () => {
  const visit = (search: string) => window.history.pushState({}, "", `/login${search}`);

  it.each(Object.entries(LOGIN_NOTICES))("?notice=%s shows its fixed text", async (key, text) => {
    visit(`?notice=${key}`);
    render(<LoginForm />);
    await waitFor(() => expect(screen.getByTestId("login-notice").textContent).toBe(text));
  });

  it.each([
    ["no notice", ""],
    ["an unknown key", "?notice=hacked"],
    ["markup", "?notice=%3Cb%3Ehi%3C%2Fb%3E"],
    ["a text of its own", "?notice=Your%20account%20was%20deleted"],
    ["an inherited property name", "?notice=constructor"],
    ["a repeated parameter", "?notice=reset&notice=invited"],
  ])("shows nothing for %s", (_name, search) => {
    visit(search);
    render(<LoginForm />);
    expect(screen.queryByTestId("login-notice")).toBeNull();
  });
});

describe("the failure message", () => {
  it("is one text, whatever the server's reason (an unknown e-mail, a wrong password, a disabled account, a lock: Auth.js answers an error code, the page one message)", async () => {
    expect(INVALID_CREDENTIALS_MESSAGE).toBe("Invalid email or password");
    for (const error of ["CredentialsSignin", "AccessDenied", "Configuration", "CallbackRouteError", "SomethingElse"]) {
      mocks.signIn.mockResolvedValue({ error });
      render(<LoginForm />);
      fireEvent.change(screen.getByTestId("login-email"), { target: { value: "me@example.com" } });
      fireEvent.change(screen.getByTestId("login-password"), { target: { value: "wrong" } });
      await act(async () => {
        fireEvent.submit(screen.getByTestId("login-form"));
      });
      await waitFor(() => expect(screen.getByTestId("login-error").textContent, error).toBe(INVALID_CREDENTIALS_MESSAGE));
      cleanup();
    }
  });
});
