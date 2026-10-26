/**
 * The whole Auth.js OAuth flow (the real `@auth/core`, with this app's `signIn` callback and guarded adapter) against stubs: an identity provider whose
 * endpoints are answered by a stub (nothing contacts a network), an in-memory adapter that records every call, and a stubbed database for the policy.
 * What this pins is what only the real flow shows: Auth.js calls the `signIn` callback BEFORE it creates, links or updates anything, so a refusal leaves
 * `createUser`, `linkAccount` and `getUserByEmail` untouched; the e-mail look-up is normalized; an unknown e-mail never creates an account even if the
 * policy were wrong (the guarded adapter); and the session cookie exists only for a sign-in that was allowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth, customFetch } from "@auth/core";
import type { Adapter, AdapterUser } from "@auth/core/adapters";

type Row = { id: string; email: string; disabledAt: Date | null };
const state = vi.hoisted(() => ({
  users: [] as Row[],
  /** provider accounts: provider + providerAccountId -> user id */
  accounts: [] as Array<{ provider: string; providerAccountId: string; userId: string }>,
  updateMany: undefined as undefined | ((args: { where: { id: string } }) => Promise<unknown>),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    account: {
      findUnique: async ({ where }: { where: { provider_providerAccountId: { provider: string; providerAccountId: string } } }) => {
        const key = where.provider_providerAccountId;
        const account = state.accounts.find((a) => a.provider === key.provider && a.providerAccountId === key.providerAccountId);
        const user = account ? state.users.find((u) => u.id === account.userId) : undefined;
        return user ? { user: { id: user.id, disabledAt: user.disabledAt } } : null;
      },
    },
    user: {
      findUnique: async ({ where }: { where: { email: string } }) => {
        const user = state.users.find((u) => u.email === where.email);
        return user ? { id: user.id, disabledAt: user.disabledAt } : null;
      },
      updateMany: (args: { where: { id: string } }) => state.updateMany!(args),
    },
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const events = vi.hoisted(() => ({ recorded: [] as Array<{ kind: string; event: Record<string, unknown> }> }));
vi.mock("@/lib/auth/throttle", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth/throttle")>()),
  isThrottled: async () => ({ throttled: false }),
  recordAuthEvent: async (kind: string, event: Record<string, unknown>) => void events.recorded.push({ kind, event }),
}));

import { guardAdapter } from "@/lib/auth/adapter-guard";
import { resetProviderProblemLog } from "@/lib/auth/providers";
import { authSignInCallback } from "@/lib/auth/sign-in-callback";

const SECRET = "provider-flow-test-secret-0123456789abcdef";
const BASE = "http://localhost:3000";

/** An adapter that remembers its calls, over the same in-memory users. */
function recordingAdapter() {
  const calls: string[] = [];
  const toAdapterUser = (row: Row): AdapterUser => ({ id: row.id, email: row.email, emailVerified: null });
  const adapter: Adapter = {
    createUser: async (user) => {
      calls.push("createUser");
      return { ...user, id: "created" } as AdapterUser;
    },
    getUser: async (id) => {
      calls.push("getUser");
      const row = state.users.find((u) => u.id === id);
      return row ? toAdapterUser(row) : null;
    },
    getUserByEmail: async (email) => {
      calls.push(`getUserByEmail:${email}`);
      const row = state.users.find((u) => u.email === email);
      return row ? toAdapterUser(row) : null;
    },
    getUserByAccount: async ({ provider, providerAccountId }) => {
      calls.push("getUserByAccount");
      const account = state.accounts.find((a) => a.provider === provider && a.providerAccountId === providerAccountId);
      const row = account ? state.users.find((u) => u.id === account.userId) : undefined;
      return row ? toAdapterUser(row) : null;
    },
    linkAccount: async (account) => {
      calls.push(`linkAccount:${account.userId}`);
      state.accounts.push({ provider: account.provider, providerAccountId: account.providerAccountId, userId: account.userId });
      return account as never;
    },
    updateUser: async (user) => {
      calls.push("updateUser");
      return user as AdapterUser;
    },
  };
  return { adapter, calls };
}

/** The identity provider: an OAuth provider whose token and user-info answers are stubs. `profile` is what its user-info says. */
function identityProvider(profile: Record<string, unknown>, options: { link?: boolean } = {}) {
  return {
    id: "keycloak",
    name: "Keycloak",
    type: "oauth" as const,
    authorization: "https://idp.invalid/authorize",
    token: "https://idp.invalid/token",
    userinfo: { url: "https://idp.invalid/userinfo", request: async () => profile },
    checks: ["state" as const],
    profile: (p: Record<string, unknown>) => ({ id: String(p.sub), name: String(p.name ?? ""), email: p.email as string }),
    options: {
      clientId: "client",
      clientSecret: "secret",
      allowDangerousEmailAccountLinking: options.link === true,
      // the token endpoint, answered here
      [customFetch]: async () => new Response(JSON.stringify({ access_token: "token", token_type: "bearer" }), { status: 200, headers: { "content-type": "application/json" } }),
    },
  };
}

function cookieHeader(response: Response, previous = ""): string {
  const jar = new Map<string, string>();
  for (const part of previous.split("; ").filter(Boolean)) jar.set(part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1));
  for (const set of response.headers.getSetCookie()) {
    const [pair] = set.split(";");
    const name = pair.slice(0, pair.indexOf("="));
    const value = pair.slice(pair.indexOf("=") + 1);
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Runs the flow: CSRF token, POST the sign-in (redirect to the provider), then the provider's callback with the state it was given. */
async function signInThroughProvider(config: Parameters<typeof Auth>[1]) {
  const csrf = await Auth(new Request(`${BASE}/api/auth/csrf`), config);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  let cookies = cookieHeader(csrf);
  const start = await Auth(
    new Request(`${BASE}/api/auth/signin/keycloak`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
      body: new URLSearchParams({ csrfToken, callbackUrl: `${BASE}/schemas` }),
    }),
    config,
  );
  const authorizeUrl = new URL(start.headers.get("location")!);
  expect(authorizeUrl.origin).toBe("https://idp.invalid");
  cookies = cookieHeader(start, cookies);
  const callback = await Auth(new Request(`${BASE}/api/auth/callback/keycloak?code=abc&state=${authorizeUrl.searchParams.get("state")}`, { headers: { cookie: cookies } }), config);
  return { callback, cookies: cookieHeader(callback, cookies) };
}

const sessionCookieOf = (response: Response) => response.headers.getSetCookie().some((set) => /^authjs\.session-token=[^;]+/.test(set));

beforeEach(() => {
  resetProviderProblemLog();
  state.users = [{ id: "user-ada", email: "ada@example.com", disabledAt: null }];
  state.accounts = [];
  state.updateMany = vi.fn(async () => ({ count: 1 }));
  events.recorded = [];
  vi.stubEnv("AUTH_PROVIDERS", "keycloak");
  vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_CLIENT_ID", "client");
  vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_CLIENT_SECRET", "secret");
  vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_ISSUER", "https://idp.invalid/realms/acme");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function configFor(profile: Record<string, unknown>, options: { link?: boolean; callback?: unknown } = {}) {
  const { adapter, calls } = recordingAdapter();
  const config = {
    secret: SECRET,
    trustHost: true,
    basePath: "/api/auth",
    session: { strategy: "jwt" as const },
    pages: { signIn: "/login", error: "/login" },
    adapter: guardAdapter(adapter),
    providers: [identityProvider(profile, { link: options.link })],
    callbacks: { signIn: (options.callback as typeof authSignInCallback | undefined) ?? authSignInCallback, jwt: async ({ token, user }: { token: Record<string, unknown>; user?: { id?: string } }) => ({ ...token, sub: user?.id ?? token.sub }) },
  } as unknown as Parameters<typeof Auth>[1];
  return { config, calls };
}

const VERIFIED = { sub: "kc-1", name: "Ada", email: "ada@example.com", email_verified: true };

describe("an e-mail nobody has an account for", () => {
  it("is refused before Auth.js touches the adapter: no createUser, no linkAccount, no e-mail look-up, no session cookie, one refused event", async () => {
    const { config, calls } = configFor({ ...VERIFIED, email: "stranger@example.com" });
    const { callback } = await signInThroughProvider(config);

    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location")!, BASE).pathname).toBe("/login");
    expect(new URL(callback.headers.get("location")!, BASE).searchParams.get("error")).toBeTruthy();
    expect(sessionCookieOf(callback)).toBe(false);
    expect(calls).toEqual(["getUserByAccount"]); // Auth.js asks for a linked account first, to hand the callback the right user; nothing else
    expect(state.users).toHaveLength(1);
    expect(events.recorded).toEqual([expect.objectContaining({ kind: "provider_refused:no-account", event: expect.objectContaining({ email: "stranger@example.com", outcome: "refused" }) })]);
  });

  it("never creates an account even when the policy is bypassed: the guarded adapter's createUser refuses (a stub callback that says yes to everyone)", async () => {
    const { config, calls } = configFor({ ...VERIFIED, email: "stranger@example.com" }, { callback: async () => true });
    const { callback } = await signInThroughProvider(config);
    expect(calls).not.toContain("createUser");
    expect(calls).toContain("getUserByEmail:stranger@example.com");
    expect(sessionCookieOf(callback)).toBe(false);
    expect(new URL(callback.headers.get("location")!, BASE).pathname).toBe("/login");
  });
});

describe("an existing local user who has not used the provider yet", () => {
  it("is refused when linking is off (the default): not-linked, nothing linked, no session", async () => {
    const { config, calls } = configFor(VERIFIED);
    const { callback } = await signInThroughProvider(config);
    expect(sessionCookieOf(callback)).toBe(false);
    expect(calls).toEqual(["getUserByAccount"]);
    expect(state.accounts).toHaveLength(0);
    expect(events.recorded.map((e) => e.kind)).toEqual(["provider_refused:not-linked"]);
  });

  it("is signed in and linked when the provider's flag is on and the e-mail is verified, even though the provider wrote the address in other letters", async () => {
    vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_LINK_EXISTING_USERS", "1");
    const { config, calls } = configFor({ ...VERIFIED, email: "Ada@Example.COM" }, { link: true });
    const { callback } = await signInThroughProvider(config);
    expect(sessionCookieOf(callback)).toBe(true);
    expect(new URL(callback.headers.get("location")!, BASE).pathname).toBe("/schemas");
    // the look-up is the normalized address, so the user the policy found is the one Auth.js finds, and nobody is created
    expect(calls).toContain("getUserByEmail:ada@example.com");
    expect(calls).toContain("linkAccount:user-ada");
    expect(calls).not.toContain("createUser");
    expect(state.accounts).toEqual([{ provider: "keycloak", providerAccountId: "kc-1", userId: "user-ada" }]);
    expect(state.updateMany).toHaveBeenCalledWith({ where: { id: "user-ada" }, data: { lastLoginAt: expect.any(Date) } });
    expect(events.recorded.map((e) => e.kind)).toEqual(["provider_login"]);
  });

  it("with the flag on, an UNVERIFIED e-mail is still refused (the flag never waives the verified-e-mail rule)", async () => {
    vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_LINK_EXISTING_USERS", "1");
    const { config, calls } = configFor({ ...VERIFIED, email_verified: false }, { link: true });
    const { callback } = await signInThroughProvider(config);
    expect(sessionCookieOf(callback)).toBe(false);
    expect(calls).toEqual(["getUserByAccount"]);
    expect(events.recorded.map((e) => e.kind)).toEqual(["provider_refused:email-unverified"]);
  });
});

describe("a user who has linked the provider account", () => {
  beforeEach(() => {
    state.accounts = [{ provider: "keycloak", providerAccountId: "kc-1", userId: "user-ada" }];
  });

  it("signs in without the flag: no link, no create, a session", async () => {
    const { config, calls } = configFor(VERIFIED);
    const { callback } = await signInThroughProvider(config);
    expect(sessionCookieOf(callback)).toBe(true);
    expect(calls).toEqual(["getUserByAccount", "getUserByAccount"]);
    expect(events.recorded.map((e) => e.kind)).toEqual(["provider_login"]);
  });

  it("is refused once disabled, with a live provider account: no session cookie", async () => {
    state.users[0].disabledAt = new Date();
    const { config, calls } = configFor(VERIFIED);
    const { callback } = await signInThroughProvider(config);
    expect(sessionCookieOf(callback)).toBe(false);
    expect(calls).toEqual(["getUserByAccount"]);
    expect(events.recorded.map((e) => e.kind)).toEqual(["provider_refused:disabled"]);
    expect(state.updateMany).not.toHaveBeenCalled();
  });
});

describe("every refusal looks the same from outside", () => {
  it("is the same redirect to the login page with the same error code, whichever rule refused (the reason is in the event, not in the response)", async () => {
    const cases: Array<[string, Record<string, unknown>, () => void]> = [
      ["no account", { email: "stranger@example.com" }, () => undefined],
      ["not linked", {}, () => undefined],
      ["unverified", { email_verified: false }, () => undefined],
      ["no e-mail", { email: "" }, () => undefined],
      [
        "disabled",
        {},
        () => {
          state.accounts = [{ provider: "keycloak", providerAccountId: "kc-1", userId: "user-ada" }];
          state.users[0].disabledAt = new Date();
        },
      ],
    ];
    const outcomes = new Map<string, string>();
    for (const [name, change, arrange] of cases) {
      state.users = [{ id: "user-ada", email: "ada@example.com", disabledAt: null }];
      state.accounts = [];
      arrange();
      const { callback } = await signInThroughProvider(configFor({ ...VERIFIED, ...change }).config);
      outcomes.set(name, `${callback.status} ${callback.headers.get("location")}`);
    }
    expect([...new Set(outcomes.values())]).toEqual([`302 ${BASE}/login?error=AccessDenied`]);
    expect([...outcomes.keys()]).toHaveLength(cases.length);
    expect(events.recorded.map((e) => e.kind)).toEqual(["provider_refused:no-account", "provider_refused:not-linked", "provider_refused:email-unverified", "provider_refused:email-missing", "provider_refused:disabled"]);
  });

  it("a linked user is identified by the provider's account id, not by the e-mail the provider writes today: a changed address still signs the same user in", async () => {
    state.accounts = [{ provider: "keycloak", providerAccountId: "kc-1", userId: "user-ada" }];
    const { callback } = await signInThroughProvider(configFor({ ...VERIFIED, email: "ada.new@example.com" }).config);
    expect(sessionCookieOf(callback)).toBe(true);
    expect(state.updateMany).toHaveBeenCalledWith({ where: { id: "user-ada" }, data: expect.anything() });
  });
});
