/**
 * `AUTH_REGISTRATION=open|invite|closed` (access-control design, decision 6): who may make an account. The default is `invite`. A value that is
 * not one of the three is the default, never "open" (and is said once in the log); the name is read from the environment when asked, not when the
 * module loads, so a test or a restart sees the setting it was given.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REGISTRATION_MODE, REGISTRATION_MODES, registrationMode } from "@/lib/auth/registration-mode";
import { googleSignInEnabled } from "@/lib/auth/providers";
import { resolveTrustHost } from "@/lib/auth/trust-host";

afterEach(() => vi.restoreAllMocks());

describe("registrationMode", () => {
  it("the modes, and the default (invite)", () => {
    expect([...REGISTRATION_MODES]).toEqual(["open", "invite", "closed"]);
    expect(DEFAULT_REGISTRATION_MODE).toBe("invite");
  });

  it.each([
    [undefined, "invite"],
    ["", "invite"],
    ["   ", "invite"],
    ["open", "open"],
    ["invite", "invite"],
    ["closed", "closed"],
    ["OPEN", "open"],
    ["  Closed ", "closed"],
    ["Invite", "invite"],
  ])("AUTH_REGISTRATION=%j is %s", (value, expected) => {
    expect(registrationMode({ AUTH_REGISTRATION: value })).toBe(expected);
  });

  it.each(["opne", "true", "1", "yes", "open,invite", "everyone", "*", "null"])("an unknown value (%j) is the default, never open, and the log says so", async (value) => {
    vi.resetModules(); // the warning is given once per process: a fresh module for each value
    const { registrationMode: fresh } = await import("@/lib/auth/registration-mode");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(fresh({ AUTH_REGISTRATION: value })).toBe("invite");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("AUTH_REGISTRATION");
    // ... once: the next request with the same setting does not repeat it
    expect(fresh({ AUTH_REGISTRATION: value })).toBe("invite");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reads process.env when no environment is given", () => {
    const before = process.env.AUTH_REGISTRATION;
    try {
      process.env.AUTH_REGISTRATION = "closed";
      expect(registrationMode()).toBe("closed");
      delete process.env.AUTH_REGISTRATION;
      expect(registrationMode()).toBe("invite");
    } finally {
      if (before === undefined) delete process.env.AUTH_REGISTRATION;
      else process.env.AUTH_REGISTRATION = before;
    }
  });
});

describe("googleSignInEnabled: the one flag for the Google provider and the login page's button", () => {
  it.each([
    [{}, false],
    [{ GOOGLE_CLIENT_ID: "" }, false],
    [{ GOOGLE_CLIENT_ID: "   " }, false],
    [{ GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com" }, true],
    [{ GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "x" }, true],
  ])("%j -> %s", (env, expected) => {
    expect(googleSignInEnabled(env)).toBe(expected);
  });

  it("is off by default (no GOOGLE_CLIENT_ID in this process)", () => {
    const before = process.env.GOOGLE_CLIENT_ID;
    try {
      delete process.env.GOOGLE_CLIENT_ID;
      expect(googleSignInEnabled()).toBe(false);
    } finally {
      if (before !== undefined) process.env.GOOGLE_CLIENT_ID = before;
    }
  });
});

describe("resolveTrustHost: the explicit trustHost option, as docs/auth-ops.md says it", () => {
  it.each([
    // development and test: trusted (Auth.js's own default there)
    [{}, true],
    [{ NODE_ENV: "development" }, true],
    [{ NODE_ENV: "test" }, true],
    // production: only with an explicit origin or an explicit "trust it"
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "production", AUTH_URL: "https://schemas.example.com" }, true],
    [{ NODE_ENV: "production", AUTH_TRUST_HOST: "true" }, true],
    [{ NODE_ENV: "production", AUTH_TRUST_HOST: "TRUE" }, true],
    [{ NODE_ENV: "production", AUTH_TRUST_HOST: "1" }, true],
    // Auth.js reads ANY set value as true, "false" and "0" included; here they are what they say
    [{ NODE_ENV: "production", AUTH_TRUST_HOST: "false" }, false],
    [{ NODE_ENV: "production", AUTH_TRUST_HOST: "0" }, false],
    [{ NODE_ENV: "production", AUTH_TRUST_HOST: "" }, false],
    [{ NODE_ENV: "production", AUTH_TRUST_HOST: "yes" }, false],
    // an empty AUTH_URL is not an origin (and does not break development, which Auth.js's own rule would)
    [{ NODE_ENV: "production", AUTH_URL: "" }, false],
    [{ NODE_ENV: "development", AUTH_URL: "" }, true],
    // NEXTAUTH_URL alone does not trust the Host in production: docs/auth-ops.md says AUTH_URL or AUTH_TRUST_HOST
    [{ NODE_ENV: "production", NEXTAUTH_URL: "http://localhost:3000" }, false],
    // The platform defaults of Auth.js (VERCEL, CF_PAGES) are not applied: they are not in the docs of this app
    [{ NODE_ENV: "production", VERCEL: "1" }, false],
    [{ NODE_ENV: "production", CF_PAGES: "1" }, false],
  ])("%j -> trusted: %s", (env, expected) => {
    expect(resolveTrustHost(env)).toBe(expected);
  });
});
