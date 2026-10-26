/**
 * `signInWithProvider` (src/app/(auth)/login/provider-actions.ts): what a provider button starts. A public action (the visitor has no session yet): it
 * starts Auth.js's sign-in ONLY for a provider the registry has enabled, and only toward a path of this site (`safeCallbackUrl`); anything else goes to
 * the login page with the generic failure. Auth.js ends a sign-in with a redirect (a throw), which passes through untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("@/lib/auth", () => ({ signIn: (...args: unknown[]) => mocks.signIn(...args) }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  },
}));

import { AuthError } from "next-auth";
import { signInWithProvider } from "@/app/(auth)/login/provider-actions";
import { resetProviderProblemLog } from "@/lib/auth/providers";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetProviderProblemLog();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("AUTH_PROVIDERS", "okta");
  vi.stubEnv("AUTH_PROVIDER_OKTA_CLIENT_ID", "client");
  vi.stubEnv("AUTH_PROVIDER_OKTA_CLIENT_SECRET", "secret");
  vi.stubEnv("AUTH_PROVIDER_OKTA_ISSUER", "https://acme.okta.test");
});

const redirected = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return (error as Error & { redirectTo: string }).redirectTo;
    throw error;
  }
};

describe("signInWithProvider", () => {
  it("starts Auth.js's sign-in for an enabled provider, toward the page that was asked for", async () => {
    mocks.signIn.mockResolvedValue(undefined);
    await signInWithProvider("okta", "/admin/settings");
    expect(mocks.signIn).toHaveBeenCalledWith("okta", { redirectTo: "/admin/settings" });
  });

  it.each([
    ["an absolute URL", "https://evil.test/"],
    ["a protocol-relative URL", "//evil.test"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["the login page itself", "/login?callbackUrl=/admin"],
    ["nothing", ""],
  ])("sends %s to the dashboard instead (the destination is attacker-controlled)", async (_name, destination) => {
    mocks.signIn.mockResolvedValue(undefined);
    await signInWithProvider("okta", destination);
    expect(mocks.signIn).toHaveBeenCalledWith("okta", { redirectTo: "/schemas" });
  });

  it.each(["github", "credentials", "", "OKTA", "constructor", "okta,github"])("never starts a sign-in for %j (not an enabled provider): the login page, with an error that says nothing", async (id) => {
    expect(await redirected(signInWithProvider(id, "/schemas"))).toBe("/login?error=AccessDenied");
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("refuses everything when no provider is configured (the default)", async () => {
    vi.stubEnv("AUTH_PROVIDERS", "");
    expect(await redirected(signInWithProvider("okta", "/schemas"))).toBe("/login?error=AccessDenied");
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a text", async () => {
    expect(await redirected(signInWithProvider({ toString: () => "okta" } as unknown as string, "/schemas"))).toBe("/login?error=AccessDenied");
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("lets Auth.js's own redirect (the throw that sends the browser to the provider) through", async () => {
    mocks.signIn.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: "https://acme.okta.test/authorize" }));
    expect(await redirected(signInWithProvider("okta", "/schemas"))).toBe("https://acme.okta.test/authorize");
  });

  it("an error of Auth.js itself (a provider that cannot start) is the generic failure on the login page, not an error page", async () => {
    mocks.signIn.mockRejectedValue(new AuthError("provider not reachable"));
    expect(await redirected(signInWithProvider("okta", "/schemas"))).toBe("/login?error=AccessDenied");
  });

  it("any other error is not swallowed", async () => {
    mocks.signIn.mockRejectedValue(new Error("boom"));
    await expect(signInWithProvider("okta", "/schemas")).rejects.toThrow("boom");
  });
});
