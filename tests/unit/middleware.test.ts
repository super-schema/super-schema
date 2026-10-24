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
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, middleware } from "@/middleware";

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

describe("a server action from a page whose session has gone", () => {
  // The browser POSTs a server action to the page's own address with a Next-Action header. A 307 to /login would be re-POSTed by the
  // browser to /login, where the action does not exist: "Server Action not found". A 401 is what the client can show.
  const post = (path: string, cookie?: string) =>
    new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers: { "next-action": "40abc", ...(cookie ? { cookie } : {}) } });

  it.each([
    ["no cookie", undefined],
    ["a garbage session cookie", `${PLAIN}=forged.not-a-valid-jwt.value`],
  ] as const)("answers 401 JSON, not a redirect: %s", async (_name, cookie) => {
    const response = await middleware(post("/schemas/billing/ledger", cookie));
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ error: "Not authenticated" });
  });

  it("is let through with a valid session", async () => {
    const response = await middleware(post("/schemas", `${PLAIN}=${await token()}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not turn a plain page request into a 401 (only the Next-Action header does)", async () => {
    expect(await redirectOf("/schemas/billing/ledger", `${PLAIN}=forged.not-a-valid-jwt.value`)).toBe("/login?callbackUrl=%2Fschemas%2Fbilling%2Fledger");
  });
});

describe("the secret", () => {
  const withEnv = async (env: { AUTH_SECRET?: string; NEXTAUTH_SECRET?: string }, run: () => Promise<void>) => {
    const before = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };
    for (const name of ["AUTH_SECRET", "NEXTAUTH_SECRET"] as const) {
      const value = env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      await run();
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  it("NEXTAUTH_SECRET alone is enough (the name .env.example and src/env.ts use)", async () => {
    const cookie = `${PLAIN}=${await token()}`;
    await withEnv({ NEXTAUTH_SECRET: SECRET }, async () => {
      expect(await redirectOf("/schemas", cookie)).toBeNull();
    });
  });

  it("with no secret at all it fails closed: even a valid-looking token is no session", async () => {
    const cookie = `${PLAIN}=${await token()}`;
    await withEnv({}, async () => {
      expect(await redirectOf("/schemas", cookie)).toBe("/login?callbackUrl=%2Fschemas");
      const api = await middleware(request("/api/domains-tree", cookie));
      expect(api.status).toBe(401);
    });
  });

  it("AUTH_SECRET is the one Auth.js reads first: a token of the other name's value is refused", async () => {
    const cookie = `${PLAIN}=${await token()}`;
    await withEnv({ AUTH_SECRET: "something-else-entirely", NEXTAUTH_SECRET: SECRET }, async () => {
      expect(await redirectOf("/schemas", cookie)).toBe("/login?callbackUrl=%2Fschemas");
    });
  });
});

describe("the public prefixes", () => {
  it("/api/v1 passes a forged cookie and a Bearer header to its handler (the handler checks an API key or the session itself)", async () => {
    const inits: NonNullable<ConstructorParameters<typeof NextRequest>[1]>[] = [
      { headers: { cookie: `${PLAIN}=forged.not-a-valid-jwt.value` } },
      { headers: { authorization: "Bearer not-a-real-key" } },
      { headers: { authorization: "Bearer not-a-real-key", cookie: "next-auth.session-token=forged" } },
    ];
    for (const init of inits) {
      const response = await middleware(new NextRequest("http://localhost:3000/api/v1/schemas", init));
      expect(response.status, JSON.stringify(init)).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("a Bearer header is no session for the pages or the app's own endpoints (only the cookie is read)", async () => {
    const bearer = { headers: { authorization: `Bearer ${await token()}` } };
    const api = await middleware(new NextRequest("http://localhost:3000/api/domains-tree", bearer));
    expect(api.status).toBe(401);
    const page = await middleware(new NextRequest("http://localhost:3000/schemas", bearer));
    expect(page.headers.get("location")).toContain("/login");
  });

  it("only exact-or-slash is an auth page: /login and /login/..., not /loginfoo or an encoded slash", async () => {
    expect(await redirectOf("/login/help", `${PLAIN}=forged`)).toBeNull();
    expect(await redirectOf("/register/", `${PLAIN}=forged`)).toBeNull();
    for (const path of ["/loginfoo", "/registerx", "/login%2F..%2Fapi%2Fdomains-tree", "/login.json"]) {
      expect(await redirectOf(path), path).not.toBeNull();
    }
    // The sign-in pages also bounce a signed-in user, by the same rule.
    const cookie = `${PLAIN}=${await token()}`;
    expect(await redirectOf("/login/help", cookie)).toBe("/schemas");
    expect(await redirectOf("/loginfoo", cookie)).toBeNull();
  });
});

describe("a session cookie in chunks", () => {
  it("is accepted: Auth.js splits a large session into authjs.session-token.0, .1 ...", async () => {
    const whole = await token();
    const middle = Math.floor(whole.length / 2);
    const cookie = `${PLAIN}.0=${whole.slice(0, middle)}; ${PLAIN}.1=${whole.slice(middle)}`;
    expect(await redirectOf("/schemas", cookie)).toBeNull();
    // ... and a chunk is not a session of its own.
    expect(await redirectOf("/schemas", `${PLAIN}.0=${whole.slice(0, middle)}`)).toBe("/login?callbackUrl=%2Fschemas");
  });
});

describe("the matcher and the shapes of an address", () => {
  const url = (path: string) => `http://localhost:3000${path}`;

  /** What a visitor with no session gets from the middleware for an address: not matched (Next serves a static file), or its answer. */
  async function outcome(path: string): Promise<string> {
    if (!unstable_doesMiddlewareMatch({ config, url: url(path) })) return "not matched";
    const response = await middleware(new NextRequest(url(path)));
    const location = response.headers.get("location");
    if (location) return `redirect ${new URL(location).pathname}`;
    return response.status === 200 ? "pass" : `${response.status}`;
  }

  it.each([
    // The app's own endpoint in the shapes a client can write it: every one of them gets 401 or a redirect, none reaches the data.
    ["/api/domains-tree", "401"],
    ["/api/domains-tree/", "401"],
    ["/api/auth/../domains-tree", "401"], // normalised to /api/domains-tree by the URL parser
    ["//api/domains-tree", "redirect /login"], // not under /api/ for the middleware: a page address, refused as one
    ["/API/domains-tree", "redirect /login"],
    ["/%61pi/domains-tree", "redirect /login"],
    ["/login%2F..%2Fapi%2Fdomains-tree", "redirect /login"],
    ["/api%2Fdomains-tree", "redirect /login"],
    ["/api/v1/../domains-tree", "401"],
    // Static files are not the middleware's business (the matcher leaves them out); they carry no data of the app.
    ["/_next/static/x", "not matched"],
    ["/_next/image", "not matched"],
    ["/favicon.ico", "not matched"],
    ["/a.png", "not matched"],
  ])("%s -> %s", async (path, expected) => {
    expect(await outcome(path)).toBe(expected);
  });

  it("no unauthenticated address of the app's data is let through", async () => {
    for (const path of ["/schemas", "/schemas/billing", "/api/tenants", "/api/compliance/gaps", "/admin", "/glossary", "/"]) {
      expect(await outcome(path), path).not.toBe("pass");
    }
  });
});
