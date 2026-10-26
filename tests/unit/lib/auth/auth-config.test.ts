/**
 * The Auth.js options of src/lib/auth.ts that this task hardens, read from the configuration the module hands to NextAuth: the session lives 12
 * hours and is renewed at most hourly, `trustHost` is written out, the credentials provider decides through `authenticateWithPassword` with the
 * client address of the request, `signIn` refuses a disabled user and records `lastLoginAt` without ever blocking, and the identity providers of the
 * registry (`AUTH_PROVIDERS`: none by default) come after credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Captured = {
  config?: {
    secret?: string;
    trustHost?: boolean;
    session?: { strategy?: string; maxAge?: number; updateAge?: number };
    jwt?: { maxAge?: number };
    pages?: { signIn?: string };
    providers?: Array<{ id: string }>;
    callbacks?: { signIn?: (args: { user?: { id?: string }; account?: { provider: string } | null }) => Promise<boolean>; jwt?: unknown; session?: unknown };
  };
  credentials?: { authorize?: (credentials: Record<string, unknown> | undefined, request: Request) => Promise<unknown> };
};
const captured = vi.hoisted((): Captured => ({}));
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), updateMany: vi.fn(), authenticateWithPassword: vi.fn() }));

vi.mock("next-auth", () => ({
  default: (config: Captured["config"]) => {
    captured.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (options: Captured["credentials"]) => {
    captured.credentials = options;
    return { id: "credentials" };
  },
}));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } } }));
vi.mock("@/lib/auth/credentials", () => ({ authenticateWithPassword: mocks.authenticateWithPassword }));

const NAMES = ["AUTH_SECRET", "NEXTAUTH_SECRET", "AUTH_PROVIDERS", "AUTH_PROVIDER_OKTA_CLIENT_ID", "AUTH_PROVIDER_OKTA_CLIENT_SECRET", "AUTH_PROVIDER_OKTA_ISSUER", "AUTH_URL", "AUTH_TRUST_HOST", "AUTH_TRUST_PROXY", "NODE_ENV"] as const;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  captured.config = undefined;
  captured.credentials = undefined;
  for (const name of NAMES) vi.stubEnv(name, undefined as unknown as string);
  vi.stubEnv("AUTH_SECRET", "auth-config-test-secret-0123456789");
  mocks.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => {
  vi.unstubAllEnvs(); // puts every stubbed name back the way it was
});

async function load() {
  await import("@/lib/auth");
  return captured;
}

describe("the session", () => {
  it("lives 12 hours and is renewed at most once an hour, as a JWT (the middleware verifies the cookie with the same secret)", async () => {
    const { config } = await load();
    expect(config?.session).toEqual({ strategy: "jwt", maxAge: 12 * 60 * 60, updateAge: 60 * 60 });
    expect(config?.jwt?.maxAge).toBe(12 * 60 * 60);
    expect(config?.secret).toBe("auth-config-test-secret-0123456789");
    expect(config?.pages?.signIn).toBe("/login");
  });
});

describe("trustHost is explicit", () => {
  it.each([
    [{}, true],
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "production", AUTH_URL: "https://schemas.example.com" }, true],
    [{ NODE_ENV: "production", AUTH_TRUST_HOST: "true" }, true],
    [{ NODE_ENV: "production", AUTH_TRUST_HOST: "false" }, false],
  ])("%j -> %s", async (env, expected) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const { config } = await load();
    expect(config?.trustHost).toBe(expected);
    expect(typeof config?.trustHost).toBe("boolean");
  });
});

describe("the providers", () => {
  const configureOkta = () => {
    vi.stubEnv("AUTH_PROVIDERS", "okta");
    vi.stubEnv("AUTH_PROVIDER_OKTA_CLIENT_ID", "0oa1234");
    vi.stubEnv("AUTH_PROVIDER_OKTA_CLIENT_SECRET", "s3cret");
    vi.stubEnv("AUTH_PROVIDER_OKTA_ISSUER", "https://acme.okta.test");
  };

  it("is the credentials provider alone by default: no identity provider", async () => {
    const { config } = await load();
    expect(config?.providers?.map((p) => p.id)).toEqual(["credentials"]);
  });

  it("adds the providers that AUTH_PROVIDERS lists, after credentials, built from the registry", async () => {
    configureOkta();
    const { config } = await load();
    expect(config?.providers?.map((p) => p.id)).toEqual(["credentials", "okta"]);
  });

  it("leaves a provider out when its settings are wrong (and logs it): credentials alone, no crash", async () => {
    configureOkta();
    vi.stubEnv("AUTH_PROVIDER_OKTA_ISSUER", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { config } = await load();
    expect(config?.providers?.map((p) => p.id)).toEqual(["credentials"]);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("AUTH_PROVIDER_OKTA_ISSUER");
    error.mockRestore();
  });
});

describe("credentials authorize", () => {
  const request = (headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/auth/callback/credentials", { method: "POST", headers });

  it("decides through authenticateWithPassword with what was typed and the client address of the request", async () => {
    mocks.authenticateWithPassword.mockResolvedValue({ id: "u1", email: "bob@example.test", name: "Bob" });
    vi.stubEnv("AUTH_TRUST_PROXY", "1");
    const { credentials } = await load();

    const user = await credentials!.authorize!({ email: " Bob@Example.test ", password: "pw" }, request({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }));

    expect(user).toEqual({ id: "u1", email: "bob@example.test", name: "Bob" });
    expect(mocks.authenticateWithPassword).toHaveBeenCalledWith({ email: " Bob@Example.test ", password: "pw", ip: "203.0.113.7" });
  });

  it("uses the constant bucket without AUTH_TRUST_PROXY=1, whatever the header says", async () => {
    mocks.authenticateWithPassword.mockResolvedValue(null);
    const { credentials } = await load();
    await credentials!.authorize!({ email: "bob@example.test", password: "pw" }, request({ "x-forwarded-for": "203.0.113.7" }));
    expect(mocks.authenticateWithPassword).toHaveBeenCalledWith(expect.objectContaining({ ip: "untrusted" }));
  });

  it("answers null when the decision does, and when there are no credentials at all", async () => {
    mocks.authenticateWithPassword.mockResolvedValue(null);
    const { credentials } = await load();
    expect(await credentials!.authorize!({ email: "bob@example.test", password: "wrong" }, request())).toBeNull();
    expect(await credentials!.authorize!(undefined, request())).toBeNull();
    expect(mocks.authenticateWithPassword).toHaveBeenLastCalledWith({ email: undefined, password: undefined, ip: "untrusted" });
  });
});

describe("the signIn callback", () => {
  const signIn = async (user: { id?: string } | undefined, account: { provider: string } | null = { provider: "credentials" }) =>
    (await load()).config!.callbacks!.signIn!({ user, account });

  it("refuses a disabled user, for any provider, and records no sign-in", async () => {
    mocks.findUnique.mockResolvedValue({ disabledAt: new Date() });
    expect(await signIn({ id: "u1" })).toBe(false);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { disabledAt: true } });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("lets an active user in and records lastLoginAt", async () => {
    mocks.findUnique.mockResolvedValue({ disabledAt: null });
    expect(await signIn({ id: "u1" })).toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "u1" }, data: { lastLoginAt: expect.any(Date) } });
  });

  it("refuses a sign-in through an identity provider until its rules are wired in: a provider's user id is no database id, so 'nobody found' must never mean 'let through'", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await signIn({ id: "provider-sub-123" }, { provider: "okta" })).toBe(false);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("lets a credentials sign-in with no usable user id through (nothing to check, nothing to write)", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await signIn(undefined)).toBe(true);
    expect(await signIn({})).toBe(true);
  });

  it("never blocks a sign-in because lastLoginAt could not be written", async () => {
    mocks.findUnique.mockResolvedValue({ disabledAt: null });
    mocks.updateMany.mockRejectedValue(new Error("database is busy"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await signIn({ id: "u1" })).toBe(true);
  });

  it("refuses when it cannot tell whether the user is disabled (fails closed)", async () => {
    mocks.findUnique.mockRejectedValue(new Error("database is down"));
    await expect(signIn({ id: "u1" })).rejects.toThrow("database is down");
  });
});
