// @vitest-environment node
/**
 * The middleware is the door of the dashboard and of the app's own JSON endpoints. It used to let anything through that carried a
 * cookie NAMED like a session cookie (any value: the browser suite's forged-cookie test got the dashboard, with every domain, in a
 * 200), and it treated every `/api/` URL as public, so `/api/domains-tree` answered a visitor with no cookie at all.
 *
 * These tests use real tokens, minted with Auth.js's own `encode` and the secret the middleware reads, so what is checked is the whole
 * decision: no cookie, a garbage cookie of either family, an expired token, a token of another secret, and a valid one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { middleware } from "@/middleware";

const SECRET = "unit-test-secret-of-the-middleware-0123456789";
const PLAIN = "authjs.session-token";
const SECURE = "__Secure-authjs.session-token";

let saved: { AUTH_SECRET?: string; NEXTAUTH_SECRET?: string };
beforeAll(() => {
  saved = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };
  process.env.AUTH_SECRET = SECRET;
  delete process.env.NEXTAUTH_SECRET;
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const token = (options: { salt?: string; secret?: string; maxAge?: number } = {}) =>
  encode({ token: { sub: "user-1", email: "a@b.c" }, secret: options.secret ?? SECRET, salt: options.salt ?? PLAIN, maxAge: options.maxAge });

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);
}

/** Where the middleware sent the request: a redirect's path and query, or null when it lets the request through. */
async function redirectOf(path: string, cookie?: string): Promise<string | null> {
  const response = await middleware(request(path, cookie));
  const location = response.headers.get("location");
  if (!location) return null;
  const url = new URL(location);
  return url.pathname + url.search;
}

describe("a page without a valid session", () => {
  it.each([
    ["no cookie", undefined],
    ["a garbage authjs.session-token", `${PLAIN}=forged.not-a-valid-jwt.value`],
    ["a garbage __Secure-authjs.session-token", `${SECURE}=forged.not-a-valid-jwt.value`],
    ["a garbage legacy next-auth.session-token", "next-auth.session-token=forged.not-a-valid-jwt.value"],
    ["a legacy-named cookie holding a VALID token", async () => `next-auth.session-token=${await token({ salt: "next-auth.session-token" })}`],
  ] as const)("is sent to /login with the page asked for: %s", async (_name, cookie) => {
    const value = typeof cookie === "function" ? await cookie() : cookie;
    expect(await redirectOf("/schemas", value)).toBe("/login?callbackUrl=%2Fschemas");
  });

  it("is sent to /login: a token of another secret, and an expired one", async () => {
    expect(await redirectOf("/schemas", `${PLAIN}=${await token({ secret: "another-secret" })}`)).toBe("/login?callbackUrl=%2Fschemas");
    expect(await redirectOf("/schemas", `${PLAIN}=${await token({ maxAge: -60 })}`)).toBe("/login?callbackUrl=%2Fschemas");
  });

  it("keeps the whole address in callbackUrl (path and query), without Next's own _rsc parameter", async () => {
    expect(await redirectOf("/schemas/billing/ledger?tab=apis&x=1")).toBe("/login?callbackUrl=%2Fschemas%2Fbilling%2Fledger%3Ftab%3Dapis%26x%3D1");
    expect(await redirectOf("/admin/settings?_rsc=abc12")).toBe("/login?callbackUrl=%2Fadmin%2Fsettings");
  });

  it("is sent to a bare /login from the root", async () => {
    expect(await redirectOf("/")).toBe("/login");
  });

  it("may open /login and /register (a forged cookie must not make a redirect loop)", async () => {
    expect(await redirectOf("/login", `${PLAIN}=forged.not-a-valid-jwt.value`)).toBeNull();
    expect(await redirectOf("/register", `${PLAIN}=forged.not-a-valid-jwt.value`)).toBeNull();
    expect(await redirectOf("/login")).toBeNull();
  });
});

describe("a page with a valid session", () => {
  it("is let through, under either cookie name", async () => {
    expect(await redirectOf("/schemas", `${PLAIN}=${await token()}`)).toBeNull();
    expect(await redirectOf("/schemas", `${SECURE}=${await token({ salt: SECURE })}`)).toBeNull();
  });

  it("is sent from / and from the login and register pages to /schemas", async () => {
    const cookie = `${PLAIN}=${await token()}`;
    expect(await redirectOf("/", cookie)).toBe("/schemas");
    expect(await redirectOf("/login", cookie)).toBe("/schemas");
    expect(await redirectOf("/register", cookie)).toBe("/schemas");
  });
});

describe("the JSON endpoints under /api", () => {
  it.each(["/api/domains-tree", "/api/tenants", "/api/compliance/gaps", "/api/command-palette-fields", "/api/ai/generate-entity"])(
    "%s answers 401 to a request without a valid session",
    async (path) => {
      for (const cookie of [undefined, `${PLAIN}=forged.not-a-valid-jwt.value`]) {
        const response = await middleware(request(path, cookie));
        expect(response.status, `${path} with ${cookie ?? "no cookie"}`).toBe(401);
        expect(response.headers.get("location")).toBeNull();
        expect(await response.json()).toEqual({ error: "Not authenticated" });
      }
    },
  );

  it("lets a valid session reach them", async () => {
    const cookie = `${PLAIN}=${await token()}`;
    for (const path of ["/api/domains-tree", "/api/tenants", "/api/compliance/gaps"]) expect(await redirectOf(path, cookie)).toBeNull();
    const response = await middleware(request("/api/domains-tree", cookie));
    expect(response.status).toBe(200);
  });

  it("leaves public what must be public: Auth.js, the REST API (it checks an API key or the session itself), the health probe, the preview assets", async () => {
    for (const path of ["/api/auth/session", "/api/auth/csrf", "/api/v1/health", "/api/v1/schemas", "/api/v1/docs", "/api/asyncapi-preview/standalone.js"]) {
      const response = await middleware(request(path));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });
});
