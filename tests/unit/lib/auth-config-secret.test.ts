/**
 * The secret Auth.js signs the session with (src/lib/auth.ts) is the one the middleware verifies it with (src/lib/session-cookie.ts), and
 * the server refuses to start in production with a weak one (src/instrumentation.ts). Before, Auth.js read `AUTH_SECRET ?? NEXTAUTH_SECRET`
 * (an empty AUTH_SECRET is not nullish: it signed with nothing) and the middleware `AUTH_SECRET || NEXTAUTH_SECRET`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ config: undefined as undefined | { secret?: string } }));

vi.mock("next-auth", () => ({
  default: (config: { secret?: string }) => {
    captured.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: () => ({ id: "credentials" }) }));
vi.mock("next-auth/providers/google", () => ({ default: () => ({ id: "google" }) }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

const NAMES = ["AUTH_SECRET", "NEXTAUTH_SECRET", "GOOGLE_CLIENT_ID"] as const;

describe("src/lib/auth.ts: the secret it signs with", () => {
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  beforeEach(() => {
    vi.resetModules();
    captured.config = undefined;
    for (const name of NAMES) delete process.env[name];
  });
  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  const secretOfConfig = async () => {
    await import("@/lib/auth");
    return captured.config?.secret;
  };

  it("is AUTH_SECRET, else NEXTAUTH_SECRET: the middleware's rule", async () => {
    process.env.AUTH_SECRET = "from-auth-secret";
    process.env.NEXTAUTH_SECRET = "from-nextauth-secret";
    expect(await secretOfConfig()).toBe("from-auth-secret");
    vi.resetModules();
    delete process.env.AUTH_SECRET;
    expect(await secretOfConfig()).toBe("from-nextauth-secret");
  });

  it("treats an EMPTY AUTH_SECRET as unset, so Auth.js signs with NEXTAUTH_SECRET like the middleware verifies with it", async () => {
    process.env.AUTH_SECRET = "";
    process.env.NEXTAUTH_SECRET = "from-nextauth-secret";
    expect(await secretOfConfig()).toBe("from-nextauth-secret");
  });

  it("is left undefined when neither name is set, so Auth.js falls back to its own rotation names (which the middleware does not read: docs/auth-ops.md)", async () => {
    expect(await secretOfConfig()).toBeUndefined();
  });
});

describe("src/instrumentation.ts: the server refuses to start in production with a weak secret", () => {
  const names = ["NODE_ENV", "NEXT_RUNTIME", "NEXT_PHASE", "AUTH_SECRET", "NEXTAUTH_SECRET"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  beforeEach(() => {
    for (const name of names) vi.stubEnv(name, undefined as unknown as string);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const name of names) if (saved[name] !== undefined) process.env[name] = saved[name];
  });

  it("throws with the reason in production on the Node runtime", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "dev-secret-change-in-production");
    const { register } = await import("@/instrumentation");
    await expect(register()).rejects.toThrow(/Refusing to start in production: the session secret is a known development value/);
  });

  it("starts with a strong secret", async () => {
    vi.stubEnv("AUTH_SECRET", "k3Jx9aP0Qm7Vb2Lr5Tz8Wd1Yn4Hc6Gf0Se3Uo9Ai2Bm=");
    const { register } = await import("@/instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });

  it("does nothing in development or test, during `next build`, or on the edge runtime", async () => {
    const { register } = await import("@/instrumentation");
    vi.stubEnv("NEXTAUTH_SECRET", "secret");
    vi.stubEnv("NODE_ENV", "development");
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("NODE_ENV", "test");
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("NEXT_PHASE", undefined as unknown as string);
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(register()).resolves.toBeUndefined();
  });
});
