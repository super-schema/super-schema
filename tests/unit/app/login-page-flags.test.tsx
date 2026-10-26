// @vitest-environment jsdom
/**
 * What the login page offers depends on the server: a button for each enabled identity provider (none by default), the "Create one"
 * link only when registration is open, and the notices of a redirect (`/login?notice=...`) are a fixed list that never shows what the address says.
 * The failure message is one text for every reason (the server-side half is tests/unit/lib/auth/credentials.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), signInWithProvider: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: (...args: unknown[]) => mocks.signIn(...args) }));
vi.mock("@/app/(auth)/login/provider-actions", () => ({ signInWithProvider: (...args: unknown[]) => mocks.signInWithProvider(...args) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import LoginPage, { dynamic } from "@/app/(auth)/login/page";
import { LoginForm } from "@/app/(auth)/login/login-form";
import { INVALID_CREDENTIALS_MESSAGE, LOGIN_NOTICES } from "@/lib/auth/messages";
import { resetProviderProblemLog } from "@/lib/auth/providers";

beforeEach(() => {
  resetProviderProblemLog();
  vi.unstubAllEnvs();
  vi.stubEnv("AUTH_PROVIDERS", "");
  vi.stubEnv("AUTH_REGISTRATION", "");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  window.history.pushState({}, "", "/");
});

describe("the login page (what the server tells the form)", () => {
  it("is rendered for each request, not baked into a build: it reads the environment", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("has NO provider button by default (AUTH_PROVIDERS is empty), and no divider that would introduce one", () => {
    render(<LoginPage />);
    expect(screen.queryByText(/or continue with email/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /continue with/i })).toBeNull();
    expect(screen.getByTestId("login-form")).toBeTruthy();
  });

  it("has one button for each ENABLED provider, in the order of AUTH_PROVIDERS, with the label the administrator gave it (the provider's name otherwise)", () => {
    vi.stubEnv("AUTH_PROVIDERS", "keycloak,github");
    vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_CLIENT_ID", "kc");
    vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_CLIENT_SECRET", "secret");
    vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_ISSUER", "https://sso.example.test/realms/acme");
    vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_LABEL", "Acme staff sign-in");
    vi.stubEnv("AUTH_PROVIDER_GITHUB_CLIENT_ID", "gh");
    vi.stubEnv("AUTH_PROVIDER_GITHUB_CLIENT_SECRET", "secret");
    render(<LoginPage />);
    const buttons = screen.getByTestId("provider-buttons").querySelectorAll("button");
    expect([...buttons].map((button) => [button.getAttribute("data-testid"), button.textContent])).toEqual([
      ["provider-button-keycloak", "Acme staff sign-in"],
      ["provider-button-github", "GitHub"],
    ]);
    expect(screen.getByText(/or continue with email/i)).toBeTruthy();
    // the password form is still there, first-class
    expect(screen.getByTestId("login-form")).toBeTruthy();
  });

  it("has no button for a provider that is configured WRONG (it is not enabled: a missing setting, an unknown name), and logs it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("AUTH_PROVIDERS", "okta,gogle");
    vi.stubEnv("AUTH_PROVIDER_OKTA_CLIENT_ID", "client");
    render(<LoginPage />);
    expect(screen.queryByTestId("provider-buttons")).toBeNull();
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/AUTH_PROVIDER_OKTA_CLIENT_SECRET[\s\S]*gogle|gogle[\s\S]*AUTH_PROVIDER_OKTA_CLIENT_SECRET/);
    error.mockRestore();
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

describe("a provider button", () => {
  const providers = [{ id: "okta", label: "Okta" }];
  const visit = (search: string) => window.history.pushState({}, "", `/login${search}`);

  it("starts the sign-in server action for ITS provider id, toward the page the middleware found the visitor on", async () => {
    visit("?callbackUrl=%2Fadmin%2Fsettings");
    mocks.signInWithProvider.mockResolvedValue(undefined);
    render(<LoginForm providers={providers} signInWithProvider={mocks.signInWithProvider} />);
    await waitFor(() => expect((screen.getByTestId("provider-button-okta") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByTestId("provider-button-okta"));
    });
    expect(mocks.signInWithProvider).toHaveBeenCalledWith("okta", "/admin/settings");
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it.each([
    ["an absolute URL", "?callbackUrl=https%3A%2F%2Fevil.com"],
    ["a protocol-relative URL", "?callbackUrl=%2F%2Fevil.com"],
    ["a repeated parameter", "?callbackUrl=%2Fadmin&callbackUrl=%2Fschemas%2Fa"],
  ])("is given the dashboard for %s (the destination is attacker-controlled)", async (_name, search) => {
    visit(search);
    mocks.signInWithProvider.mockResolvedValue(undefined);
    render(<LoginForm providers={providers} signInWithProvider={mocks.signInWithProvider} />);
    await waitFor(() => expect((screen.getByTestId("provider-button-okta") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByTestId("provider-button-okta"));
    });
    expect(mocks.signInWithProvider).toHaveBeenCalledWith("okta", "/schemas");
  });
});

describe("a refused provider sign-in comes back to the login page", () => {
  const visit = (search: string) => window.history.pushState({}, "", `/login${search}`);

  it.each(["AccessDenied", "OAuthAccountNotLinked", "Configuration", "OAuthCallbackError", "whatever"])("?error=%s shows the generic failure and nothing else (the code is never shown)", async (code) => {
    visit(`?error=${code}`);
    render(<LoginForm />);
    await waitFor(() => expect(screen.getByTestId("login-error").textContent).toBe(INVALID_CREDENTIALS_MESSAGE));
    expect(document.body.textContent).not.toContain(code);
  });

  it("shows markup in the address as nothing at all", async () => {
    visit("?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E");
    const { container } = render(<LoginForm />);
    await waitFor(() => expect(screen.getByTestId("login-error").textContent).toBe(INVALID_CREDENTIALS_MESSAGE));
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows no failure without an error on the address (or with an empty one)", () => {
    visit("");
    render(<LoginForm />);
    expect(screen.queryByTestId("login-error")).toBeNull();
    cleanup();
    visit("?error=");
    render(<LoginForm />);
    expect(screen.queryByTestId("login-error")).toBeNull();
  });
});

describe("the login form's props are the whole story", () => {
  it("shows the registration link for registrationOpen, and not without it", () => {
    render(<LoginForm />);
    expect(screen.queryByTestId("login-register-link")).toBeNull();
    cleanup();
    render(<LoginForm registrationOpen />);
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
