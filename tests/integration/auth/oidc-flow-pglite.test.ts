/** Real Auth.js OIDC protocol flow + production registry, policy and Prisma adapter over a temporary migrated database.
 * Only the identity provider transport and Next request headers are replaced. No network or development database is used. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth, customFetch, type AuthConfig } from "@auth/core";
import { getToken } from "@auth/core/jwt";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { guardAdapter } from "@/lib/auth/adapter-guard";
import { resolveProviderRegistry, resetProviderProblemLog } from "@/lib/auth/providers";
import { authSignInCallback } from "@/lib/auth/sign-in-callback";

const BASE = "https://schemas.example.test";
const ISSUER = "https://idp.example.test/realms/acme";
const SECRET = "9a683d68d55e4b6f9fa588acbb27a9f9";
const CLIENT_ID = "schemas";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const db = () => holder.db!.prisma;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const hasSession = (response: Response) => response.headers.getSetCookie().some((value) => /^__Secure-authjs\.session-token=[^;]+/.test(value));

function cookieJar(response: Response, previous = "") {
  const jar = new Map(previous.split("; ").filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  for (const entry of response.headers.getSetCookie()) {
    const pair = entry.split(";")[0];
    const name = pair.slice(0, pair.indexOf("="));
    const value = pair.slice(pair.indexOf("=") + 1);
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function signedIdToken(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${body}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

/** Discovery and token responses from an isolated test IdP. It enforces the actual PKCE verifier, redirect URI and client authentication. */
function identityProvider(claims: Record<string, unknown> = {}) {
  let authorization: URL;
  let tokenRequests = 0;
  let usedCode = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) return json({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`, jwks_uri: `${ISSUER}/jwks`, response_types_supported: ["code"],
      subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"], code_challenge_methods_supported: ["S256"],
    });
    if (url.href === `${ISSUER}/jwks`) return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" }] });
    if (url.href === `${ISSUER}/token`) {
      tokenRequests++;
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/oidc`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:client-secret`).toString("base64")}`);
      const verifier = form.get("code_verifier");
      expect(verifier).toBeTruthy();
      expect(createHash("sha256").update(verifier!).digest("base64url")).toBe(authorization.searchParams.get("code_challenge"));
      if (usedCode) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      usedCode = true;
      const now = Math.floor(Date.now() / 1000);
      return json({ access_token: "isolated-test-access-token", token_type: "Bearer", expires_in: 300,
        id_token: signedIdToken({ iss: ISSUER, aud: CLIENT_ID, sub: "employee-1", iat: now, exp: now + 300,
          nonce: authorization.searchParams.get("nonce"), email: "ada@example.com", email_verified: true, name: "Ada", ...claims }),
      });
    }
    throw new Error(`Unexpected IdP endpoint: ${url.origin}${url.pathname}`);
  };

  const configured = resolveProviderRegistry().enabled[0].provider;
  if (typeof configured === "function" || configured.type !== "oidc") throw new Error("Expected the configured OIDC provider");
  const config: AuthConfig = {
    secret: SECRET, trustHost: true, basePath: "/api/auth", session: { strategy: "jwt", maxAge: 43200 },
    adapter: guardAdapter(PrismaAdapter(db())),
    providers: [{ ...configured, [customFetch]: transport }],
    pages: { signIn: "/login", error: "/login" },
    callbacks: { signIn: authSignInCallback },
    logger: { error: () => undefined, warn: () => undefined, debug: () => undefined },
  };
  return { config, authorize: (url: URL) => { authorization = url; }, tokenRequests: () => tokenRequests };
}

async function startFlow(claims: Record<string, unknown> = {}) {
  const idp = identityProvider(claims);
  const csrf = await Auth(new Request(`${BASE}/api/auth/csrf`), idp.config);
  const { csrfToken } = await csrf.json();
  const response = await Auth(new Request(`${BASE}/api/auth/signin/oidc`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieJar(csrf) },
    body: new URLSearchParams({ csrfToken, callbackUrl: `${BASE}/schemas` }),
  }), idp.config);
  const authorization = new URL(response.headers.get("location")!);
  expect(authorization.origin).toBe("https://idp.example.test");
  expect(authorization.searchParams.get("scope")).toBe("openid profile email");
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("state")).toBeTruthy();
  expect(authorization.searchParams.get("nonce")).toBeTruthy();
  idp.authorize(authorization);
  const cookies = cookieJar(response, cookieJar(csrf));
  const callbackUrl = new URL(`${BASE}/api/auth/callback/oidc`);
  callbackUrl.searchParams.set("code", "one-use-code");
  callbackUrl.searchParams.set("state", authorization.searchParams.get("state")!);
  return { ...idp, authorization, cookies, callbackUrl };
}

async function finish(flow: Awaited<ReturnType<typeof startFlow>>, cookies = flow.cookies) {
  const response = await Auth(new Request(flow.callbackUrl, { headers: { cookie: cookies } }), flow.config);
  return { response, cookies: cookieJar(response, cookies) };
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  resetProviderProblemLog();
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_PROVIDERS", "oidc");
  vi.stubEnv("AUTH_PROVIDER_OIDC_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("AUTH_PROVIDER_OIDC_CLIENT_SECRET", "client-secret");
  vi.stubEnv("AUTH_PROVIDER_OIDC_ISSUER", ISSUER);
  vi.stubEnv("AUTH_PROVIDER_OIDC_LABEL", "Company SSO");
  vi.stubEnv("AUTH_PROVIDER_OIDC_ALLOWED_DOMAINS", "example.com");
  vi.stubEnv("AUTH_PROVIDER_OIDC_LINK_EXISTING_USERS", "1");
  vi.stubGlobal("fetch", () => { throw new Error("The OIDC tests must never use the network"); });
  await db().authEvent.deleteMany();
  await db().account.deleteMany();
  await db().userRole.deleteMany();
  await db().user.deleteMany();
  await db().user.create({ data: { email: "ada@example.com", name: "Ada" } });
}, 120_000);

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await holder.db?.close(); });

describe("SSO with the real Auth.js OIDC flow and Prisma adapter", () => {
  it("discovers the issuer, exchanges an authorization code with PKCE, links only the existing account and issues a usable secure session", async () => {
    const user = await db().user.findUniqueOrThrow({ where: { email: "ada@example.com" } });
    const flow = await startFlow();
    const { response, cookies } = await finish(flow);
    expect(response.headers.get("location")).toBe(`${BASE}/schemas`);
    expect(hasSession(response)).toBe(true);
    expect(response.headers.getSetCookie().find((value) => value.startsWith("__Secure-authjs.session-token="))).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect((await getToken({ req: new Request(BASE, { headers: { cookie: cookies } }), secret: SECRET, secureCookie: true }))?.sub).toBe(user.id);
    expect(await db().account.findUnique({ where: { provider_providerAccountId: { provider: "oidc", providerAccountId: "employee-1" } } })).toMatchObject({ userId: user.id, type: "oidc" });
    expect(await db().user.count()).toBe(1);
    expect((await db().user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt).toBeInstanceOf(Date);
    expect((await db().authEvent.findMany()).map(({ kind }) => kind)).toContain("provider_login");

    const csrf = await Auth(new Request(`${BASE}/api/auth/csrf`, { headers: { cookie: cookies } }), flow.config);
    const { csrfToken } = await csrf.json();
    const signedOut = await Auth(new Request(`${BASE}/api/auth/signout`, {
      method: "POST", headers: { cookie: cookieJar(csrf, cookies), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken }),
    }), flow.config);
    expect(await getToken({ req: new Request(BASE, { headers: { cookie: cookieJar(signedOut, cookies) } }), secret: SECRET, secureCookie: true })).toBeNull();
  });

  it("recognizes the stable subject after an email change and after first-login linking is turned off", async () => {
    await finish(await startFlow());
    vi.stubEnv("AUTH_PROVIDER_OIDC_LINK_EXISTING_USERS", "0");
    const { response } = await finish(await startFlow({ email: "new-address@example.com" }));
    expect(hasSession(response)).toBe(true);
    expect(await db().user.count()).toBe(1);
    expect(await db().account.count()).toBe(1);
  });

  it.each([
    ["nonce mismatch", { nonce: "another-browser" }],
    ["wrong audience", { aud: "another-application" }],
    ["wrong issuer", { iss: "https://other.example.test" }],
    ["expired token", { exp: 1 }],
    ["missing subject", { sub: null }],
    ["unverified email", { email_verified: false }],
    ["unverified claim type", { email_verified: "true" }],
    ["missing email", { email: null }],
    ["forbidden domain", { email: "ada@attacker.test" }],
    ["unprovisioned user", { email: "unknown@example.com" }],
  ])("refuses %s without a session, new user or account link", async (_name, claims) => {
    const { response } = await finish(await startFlow(claims));
    expect(hasSession(response)).toBe(false);
    expect(new URL(response.headers.get("location")!, BASE).pathname).toBe("/login");
    expect(await db().account.count()).toBe(0);
    expect(await db().user.count()).toBe(1);
  });

  it("refuses a disabled account before linking", async () => {
    await db().user.updateMany({ data: { disabledAt: new Date() } });
    expect(hasSession((await finish(await startFlow())).response)).toBe(false);
    expect(await db().account.count()).toBe(0);
  });

  it("refuses the first sign-in when email linking is disabled", async () => {
    vi.stubEnv("AUTH_PROVIDER_OIDC_LINK_EXISTING_USERS", "0");
    expect(hasSession((await finish(await startFlow())).response)).toBe(false);
    expect(await db().account.count()).toBe(0);
  });

  it("rejects a changed state before contacting the token endpoint", async () => {
    const flow = await startFlow();
    flow.callbackUrl.searchParams.set("state", "attacker-state");
    expect(hasSession((await finish(flow)).response)).toBe(false);
    expect(flow.tokenRequests()).toBe(0);
    expect(await db().account.count()).toBe(0);
  });

  it("refuses a callback without its browser cookies before contacting the token endpoint", async () => {
    const flow = await startFlow();
    expect(hasSession((await finish(flow, "")).response)).toBe(false);
    expect(flow.tokenRequests()).toBe(0);
  });

  it("refuses replay with the consumed browser cookies and with the original one-use authorization code", async () => {
    const flow = await startFlow();
    const first = await finish(flow);
    expect(hasSession(first.response)).toBe(true);
    expect(hasSession((await finish(flow, first.cookies)).response)).toBe(false);
    expect(hasSession((await finish(flow, flow.cookies)).response)).toBe(false);
    expect(await db().account.count()).toBe(1);
  });
});
