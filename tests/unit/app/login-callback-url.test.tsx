// @vitest-environment jsdom
/**
 * After a successful login the user goes where the middleware found them (`/login?callbackUrl=<page>`), but only to a path of this
 * site: the parameter is attacker-controlled (the validator itself is tests/unit/lib/safe-callback-url.test.ts; this is the page).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: (...args: unknown[]) => mocks.signIn(...args) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));

import { LoginForm } from "@/app/(auth)/login/login-form";

// Google sign-in is configured for these tests (the server tells the form so: tests/unit/app/login-page-flags.test.tsx is the other side).
const LoginPage = () => <LoginForm googleEnabled />;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.pushState({}, "", "/");
});

/** The address of the login page the visitor was sent to (the page reads it when the form is sent, not while it renders). */
const visit = (search: string) => window.history.pushState({}, "", `/login${search}`);

async function signInAt(search: string) {
  visit(search);
  mocks.signIn.mockResolvedValue({ ok: true, error: undefined });
  render(<LoginPage />);
  fireEvent.change(screen.getByTestId("login-email"), { target: { value: "me@example.com" } });
  fireEvent.change(screen.getByTestId("login-password"), { target: { value: "right" } });
  await act(async () => {
    fireEvent.submit(screen.getByTestId("login-form"));
  });
  await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
  return mocks.push.mock.calls[0][0] as string;
}

describe("login page: where a signed-in user goes", () => {
  it("goes to the page the middleware found them on, path, query and hash", async () => {
    expect(await signInAt("?callbackUrl=%2Fadmin%2Fsettings")).toBe("/admin/settings");
  });

  it("keeps the query of that page", async () => {
    expect(await signInAt(`?callbackUrl=${encodeURIComponent("/schemas/billing/ledger?tab=apis&x=1")}`)).toBe("/schemas/billing/ledger?tab=apis&x=1");
  });

  it("goes to the dashboard without a callbackUrl", async () => {
    expect(await signInAt("")).toBe("/schemas");
  });

  it.each([
    ["a protocol-relative URL", "?callbackUrl=%2F%2Fevil.com"],
    ["an absolute URL", "?callbackUrl=https%3A%2F%2Fevil.com"],
    ["a javascript: URL", "?callbackUrl=javascript%3Aalert(1)"],
    ["an encoded backslash host", "?callbackUrl=%2F%255Cevil.com"],
    ["the login page itself (a loop)", "?callbackUrl=%2Flogin%3FcallbackUrl%3D%2Fadmin"],
    ["a repeated parameter", "?callbackUrl=%2Fadmin&callbackUrl=%2Fschemas%2Fa"],
  ])("goes to the dashboard for %s", async (_name, search) => {
    expect(await signInAt(search)).toBe("/schemas");
  });

  it("refreshes the router after it pushes (the server components see the new session)", async () => {
    await signInAt("?callbackUrl=%2Fadmin");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("gives Google sign-in the same safe destination", () => {
    visit("?callbackUrl=%2F%2Fevil.com");
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(mocks.signIn).toHaveBeenCalledWith("google", { callbackUrl: "/schemas" });
    cleanup();
    mocks.signIn.mockClear();
    visit("?callbackUrl=%2Fadmin%2Fsettings");
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(mocks.signIn).toHaveBeenCalledWith("google", { callbackUrl: "/admin/settings" });
  });
});
