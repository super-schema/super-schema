/**
 * src/env.ts declares the sign-in settings of this task next to the others, with the values the readers accept: `AUTH_REGISTRATION` (open, invite,
 * closed; default invite; an empty value is unset), `AUTH_TRUST_PROXY` and `AUTH_PROVIDERS` (the provider table reads it). The app reads them through
 * src/lib/auth/registration-mode.ts, src/lib/auth/throttle.ts and src/lib/auth/providers.ts (the table of identity providers), not through this module (which is not imported by the
 * app: its required DATABASE_URL would break a zero-config PGlite start); this keeps the declaration and the readers from drifting apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registrationMode } from "@/lib/auth/registration-mode";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/db");
  vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
  vi.stubEnv("NEXTAUTH_SECRET", "env-schema-test-secret");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_REGISTRATION", undefined as unknown as string);
  vi.stubEnv("AUTH_TRUST_PROXY", undefined as unknown as string);
  vi.stubEnv("AUTH_PROVIDERS", undefined as unknown as string);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const loadEnv = async () => (await import("@/env")).env;

describe("AUTH_REGISTRATION in src/env.ts", () => {
  it("defaults to invite, and an empty value is the same as unset", async () => {
    expect((await loadEnv()).AUTH_REGISTRATION).toBe("invite");
    vi.resetModules();
    vi.stubEnv("AUTH_REGISTRATION", "");
    expect((await loadEnv()).AUTH_REGISTRATION).toBe("invite");
  });

  it.each(["open", "invite", "closed"])("accepts %s, and the reader says the same", async (value) => {
    vi.stubEnv("AUTH_REGISTRATION", value);
    expect((await loadEnv()).AUTH_REGISTRATION).toBe(value);
    expect(registrationMode({ AUTH_REGISTRATION: value })).toBe(value);
  });

  it("refuses a value that is none of the three (a typo must not pass validation as 'open')", async () => {
    vi.stubEnv("AUTH_REGISTRATION", "everyone");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(import("@/env")).rejects.toThrow(/Invalid environment variables/);
  });
});

describe("the other sign-in settings in src/env.ts", () => {
  it("are optional strings, unset by default", async () => {
    const env = await loadEnv();
    expect(env.AUTH_TRUST_PROXY).toBeUndefined();
    expect(env.AUTH_PROVIDERS).toBeUndefined();
  });

  it("carry the value they are given", async () => {
    vi.stubEnv("AUTH_TRUST_PROXY", "1");
    vi.stubEnv("AUTH_PROVIDERS", "okta,keycloak");
    const env = await loadEnv();
    expect(env.AUTH_TRUST_PROXY).toBe("1");
    expect(env.AUTH_PROVIDERS).toBe("okta,keycloak");
  });
});
