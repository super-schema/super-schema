// @vitest-environment node
/**
 * `withApiAuth` (src/lib/access/api.ts): the guard in front of every API route that serves tenant data. Before the handler runs it answers
 * who (401), which tenant (404 for a caller who may reach none: never a 500), and whether any role of the caller reaches the action (403);
 * the API key is a service principal bound to a tenant and a role; the rows are the handler's, with the readable scopes it is handed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalModule, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), activeTenant: vi.fn(), prisma: {} }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/active-tenant")>()), getActiveTenantId: mocks.activeTenant }));

import { NoTenantAccess } from "@/lib/access/no-tenant-access";
import { APP_ERRORS, COMPLIANCE_ERRORS, withApiAuth, type ApiAuth } from "@/lib/access/api";
import type { ActionId } from "@/lib/access";

const ok = () => new Response("handled", { status: 200 });
const request = (headers: Record<string, string> = {}) => new Request("http://localhost/api/v1/x", { headers });
const route = { params: Promise.resolve({}) };
const bodyOf = async (response: Response) => JSON.parse(await response.text());

let seen: ApiAuth | undefined;
const handler = vi.fn(async (_request: Request, api: ApiAuth) => {
  seen = api;
  return ok();
});

const SAVED = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  seen = undefined;
  delete process.env.API_KEY;
  delete process.env.API_KEY_ROLE;
  delete process.env.API_KEY_TENANT_ID;
  mocks.activeTenant.mockResolvedValue("t1");
  signInAs(tenantMember("VIEWER", "t1"));
});
afterEach(() => {
  process.env = { ...SAVED };
});

const call = (action: ActionId, headers: Record<string, string> = {}, options?: Parameters<typeof withApiAuth>[2]) => withApiAuth(action, handler, options)(request(headers), route);

describe("who is calling", () => {
  it("is a 401 in the API's envelope for nobody, and the handler never runs", async () => {
    signedOut();
    const response = await call("entity.read");
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("a wrong key is refused and the session next to it is not the fallback (the principal is not even asked)", async () => {
    process.env.API_KEY = "the-key-of-the-run";
    for (const token of ["not-the-key", "the-key-of-the-run-x", "the-key-of-the-run".slice(0, -1)]) {
      const response = await call("entity.read", { authorization: `Bearer ${token}` });
      expect(response.status, token).toBe(401);
    }
    expect(principalModule.getPrincipal).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("a bearer token with no key configured is nobody (the key authentication is off)", async () => {
    expect((await call("entity.read", { authorization: "Bearer anything" })).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("an empty bearer token, or another scheme, is judged by the session", async () => {
    process.env.API_KEY = "the-key-of-the-run";
    for (const authorization of ["Bearer ", "Bearer    ", "Basic dXNlcjpwYXNz", "bearer-without-space"]) {
      expect((await call("entity.read", { authorization })).status, authorization).toBe(200);
    }
    expect(principalModule.getPrincipal).toHaveBeenCalledTimes(4);
  });

  it("a disabled user or a stale session (no principal) is a 401", async () => {
    principalModule.getPrincipal.mockResolvedValue(null);
    expect((await call("entity.read")).status).toBe(401);
  });

  it("failing to look up who is calling is a generic 500 (nothing of the cause), or the route's own answer", async () => {
    principalModule.getPrincipal.mockRejectedValue(new Error("connection to db.internal:5432 refused"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await call("entity.read");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/db\.internal|refused/);
    const own = await call("notification.own", {}, { authFailure: () => new Response("none", { status: 200 }) });
    expect(own.status).toBe(200);
    spy.mockRestore();
  });

  it("answers with the route's polling reply instead of the 401 when it has one", async () => {
    signedOut();
    const response = await call("notification.own", {}, { unauthenticated: () => new Response("{\"unreadCount\":0}", { status: 200 }) });
    expect(response.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs `before` first (the rate limit counts a request without a credential): its answer ends the request before anyone is looked up", async () => {
    signedOut();
    const response = await call("entity.read", {}, { before: () => new Response("slow down", { status: 429 }) });
    expect(response.status).toBe(429);
    expect(principalModule.getPrincipal).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("the API key is a service principal bound to a tenant and a role", () => {
  const KEY = { authorization: "Bearer the-key-of-the-run" };
  beforeEach(() => {
    process.env.API_KEY = "the-key-of-the-run";
  });

  it("by default it is an administrator acting in the default tenant (what existing integrations rely on); no session is asked", async () => {
    expect((await call("entity.read", KEY)).status).toBe(200);
    expect(seen?.source).toBe("api-key");
    expect(seen?.tenantId).toBe("tenant_default");
    expect(seen?.principal.isGlobalAdmin).toBe(true);
    expect(seen?.ctx.tenantId).toBe("tenant_default");
    expect(seen?.ctx.assignments).toEqual([{ role: "ADMIN", scope: { kind: "GLOBAL" } }]);
    expect(principalModule.getPrincipal).not.toHaveBeenCalled();
    expect(mocks.activeTenant).not.toHaveBeenCalled();
  });

  it("an administrator key may use the platform actions (webhooks)", async () => {
    expect((await call("platform.admin", KEY)).status).toBe(200);
  });

  it("API_KEY_TENANT_ID names the tenant it acts in; API_KEY_ROLE a lower role is held in THAT tenant only (no platform rights)", async () => {
    process.env.API_KEY_TENANT_ID = "t9";
    process.env.API_KEY_ROLE = "VIEWER";
    expect((await call("entity.read", KEY)).status).toBe(200);
    expect(seen?.tenantId).toBe("t9");
    expect(seen?.principal.assignments).toEqual([{ role: "VIEWER", scope: { kind: "TENANT", tenantId: "t9" } }]);
    expect(seen?.principal.isGlobalAdmin).toBe(false);
    expect((await call("platform.admin", KEY)).status).toBe(403);
    expect((await call("entity.write", KEY)).status).toBe(403);
  });

  it("blank settings are the defaults, not an empty tenant or a no-role key", async () => {
    process.env.API_KEY_TENANT_ID = "  ";
    process.env.API_KEY_ROLE = "";
    expect((await call("entity.read", KEY)).status).toBe(200);
    expect(seen?.tenantId).toBe("tenant_default");
    expect(seen?.principal.isGlobalAdmin).toBe(true);
  });

  it("an API_KEY_ROLE that is not a role turns the key OFF: it never falls back to administrator", async () => {
    for (const role of ["admin", "SUPERUSER", "ADMIN ", "constructor", "__proto__"]) {
      process.env.API_KEY_ROLE = role;
      const response = await call("entity.read", KEY);
      // "ADMIN " is trimmed to ADMIN (a space in an .env line is not a different role); the rest are refused
      expect(response.status, role).toBe(role === "ADMIN " ? 200 : 401);
    }
  });

  it("the key is ignored on a route that answers to a session only", async () => {
    signedOut();
    expect((await call("entity.read", KEY, { allowApiKey: false })).status).toBe(401);
    expect(principalModule.getPrincipal).toHaveBeenCalled();
  });
});

describe("a session carries its real roles", () => {
  it("a viewer in the tenant reads (every row) and may not write", async () => {
    expect((await call("entity.read")).status).toBe(200);
    expect(seen?.source).toBe("session");
    expect(seen?.tenantId).toBe("t1");
    expect(seen?.scopes).toEqual({ all: true });
    expect(seen?.ctx.assignments).toEqual([{ role: "VIEWER", scope: { kind: "TENANT", tenantId: "t1" } }]);
    expect((await call("entity.write")).status).toBe(403);
    expect((await call("platform.admin")).status).toBe(403);
  });

  it("the active tenant is asked of the principal already loaded (one read), and a role in a tenant not in view is no role here", async () => {
    signInAs(tenantMember("AUTHOR", "t2"));
    expect((await call("entity.read")).status).toBe(404);
    expect(mocks.activeTenant).toHaveBeenCalledWith(expect.objectContaining({ userId: "member-1" }));
  });

  it("a domain-scoped author reads and writes through the scopes of that domain only", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", "t1", "dom-a")]));
    expect((await call("entity.write")).status).toBe(200);
    expect(seen?.scopes).toEqual({ all: false, domainIds: ["dom-a"], productIds: [] });
    // a role that reaches no domain of this action: forbidden (the tenant is theirs, the action is not)
    expect((await call("deploy.run")).status).toBe(403);
    expect((await call("domain.create")).status).toBe(403);
  });

  it("a platform action needs a GLOBAL administrator: a tenant administrator is refused, a platform one passes with no tenant looked up", async () => {
    signInAs(tenantMember("ADMIN", "t1"));
    expect((await call("platform.admin")).status).toBe(403);
    signInAs(globalAdmin());
    expect((await call("platform.admin")).status).toBe(200);
    expect(seen?.tenantId).toBeNull();
    expect(seen?.scopes).toBeNull();
    expect(mocks.activeTenant).not.toHaveBeenCalled();
  });

  it("an own-things action (notifications) is open to any principal, a roleless one included", async () => {
    signInAs(roleless());
    expect((await call("notification.own")).status).toBe(200);
    expect(seen?.principal.userId).toBe("nobody-1");
  });

  it("an action id that is not in the table is refused for everyone, an administrator included", async () => {
    signInAs(globalAdmin());
    for (const id of ["entity.destroy", "constructor", "__proto__", ""]) {
      expect((await withApiAuth(id as ActionId, handler)(request(), route)).status, id).toBe(403);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("a roleless user is never a 500", () => {
  it("has no tenant (NoTenantAccess): content is a 404 'Not found', a platform action a 403, notifications still answer", async () => {
    signInAs(roleless());
    mocks.activeTenant.mockRejectedValue(new NoTenantAccess());
    const content = await call("entity.read");
    expect(content.status).toBe(404);
    expect(await bodyOf(content)).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
    expect((await call("platform.admin")).status).toBe(403);
    expect((await call("notification.own")).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("has a tenant in view but no role in it: the same 404 (no existence oracle)", async () => {
    signInAs(roleless());
    expect((await call("entity.read")).status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a handler that asks for the tenant itself and fails with NoTenantAccess is a 404 too; any other failure a generic 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const noAccess = await withApiAuth("entity.read", async () => {
      throw new NoTenantAccess();
    })(request(), route);
    expect(noAccess.status).toBe(404);
    const broken = await withApiAuth("entity.read", async () => {
      throw new Error("SELECT * FROM secrets failed at /srv/app/node_modules/pg");
    })(request(), route);
    expect(broken.status).toBe(500);
    expect(await broken.text()).not.toMatch(/secrets|node_modules/);
    spy.mockRestore();
  });
});

describe("the answer takes the route's own shape", () => {
  it("the app's endpoints: { error }", async () => {
    signedOut();
    const none = await call("entity.read", {}, { respond: APP_ERRORS });
    expect([none.status, await bodyOf(none)]).toEqual([401, { error: "Not authenticated" }]);
    signInAs(roleless());
    const hidden = await call("entity.read", {}, { respond: APP_ERRORS });
    expect([hidden.status, await bodyOf(hidden)]).toEqual([404, { error: "Not found" }]);
    signInAs(tenantMember("VIEWER", "t1"));
    const low = await call("entity.write", {}, { respond: APP_ERRORS });
    expect([low.status, await bodyOf(low)]).toEqual([403, { error: "You do not have permission to do this" }]);
  });

  it("the compliance endpoints: { success: false, error }", async () => {
    signedOut();
    const none = await call("compliance.query", {}, { respond: COMPLIANCE_ERRORS });
    expect([none.status, await bodyOf(none)]).toEqual([401, { success: false, error: "Not authenticated" }]);
    signInAs(tenantMember("VIEWER", "t1"));
    const forbidden = await call("compliance.query", {}, { respond: COMPLIANCE_ERRORS });
    expect([forbidden.status, await bodyOf(forbidden)]).toEqual([403, { success: false, error: "You do not have permission to do this" }]);
  });

  it("the REST API: { success: false, error: { code, message } }, naming no role, action or tenant", async () => {
    const forbidden = await call("platform.admin");
    const text = await forbidden.text();
    expect(JSON.parse(text)).toEqual({ success: false, error: { code: "FORBIDDEN", message: "You do not have permission to do this" } });
    expect(text).not.toMatch(/ADMIN|platform|t1|VIEWER/);
  });
});

describe("the REST API's rate limits (rateLimit: true, src/app/api/v1/rate-limit.ts)", () => {
  const RATE = { rateLimit: true } as const;
  const SAVED_TRUST = process.env.AUTH_TRUST_PROXY;
  // The limiter keeps its windows for the life of the module: each test starts two minutes after the one before, so none of them sees another's.
  let minutesBefore = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 25, 12) + minutesBefore++ * 120_000));
  });
  afterEach(() => {
    vi.useRealTimers();
    if (SAVED_TRUST === undefined) delete process.env.AUTH_TRUST_PROXY;
    else process.env.AUTH_TRUST_PROXY = SAVED_TRUST;
  });

  it("an authenticated request counts against its principal: the 101st of one user is a 429 and the handler does not run for it", async () => {
    signInAs(tenantMember("VIEWER", "t1", "limited-user-1"));
    for (let i = 0; i < 100; i += 1) expect((await call("entity.read", {}, RATE)).status, String(i + 1)).toBe(200);
    const limited = await call("entity.read", {}, RATE);
    expect(limited.status).toBe(429);
    expect(await bodyOf(limited)).toMatchObject({ success: false, error: { code: "RATE_LIMITED" } });
    expect(handler).toHaveBeenCalledTimes(100);
  });

  it("another principal is not limited by it, and the api key's principal is its own", async () => {
    signInAs(tenantMember("VIEWER", "t1", "limited-user-2"));
    for (let i = 0; i < 101; i += 1) await call("entity.read", {}, RATE);
    expect((await call("entity.read", {}, RATE)).status).toBe(429);
    signInAs(tenantMember("VIEWER", "t1", "limited-user-3"));
    expect((await call("entity.read", {}, RATE)).status).toBe(200);
  });

  it("a request that does not authenticate counts against its client address: the 21st from it is a 429, and the 401s before it are unchanged", async () => {
    process.env.AUTH_TRUST_PROXY = "1";
    signedOut();
    const from = { "x-forwarded-for": "203.0.113.50" };
    for (let i = 0; i < 20; i += 1) expect((await call("entity.read", from, RATE)).status, String(i + 1)).toBe(401);
    const limited = await call("entity.read", from, RATE);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(handler).not.toHaveBeenCalled();
    // another address is another client
    expect((await call("entity.read", { "x-forwarded-for": "203.0.113.51" }, RATE)).status).toBe(401);
  });

  it("a valid session is never refused because failed requests used up their allowance (no trusted proxy: one shared allowance of failures)", async () => {
    delete process.env.AUTH_TRUST_PROXY;
    signedOut();
    for (let i = 0; i < 21; i += 1) await call("entity.read", { "x-forwarded-for": `198.51.100.${i + 1}` }, RATE);
    expect((await call("entity.read", {}, RATE)).status).toBe(429);
    signInAs(tenantMember("VIEWER", "t1", "limited-user-4"));
    expect((await call("entity.read", {}, RATE)).status).toBe(200);
  });

  it("a failed request does not spend the principal's allowance, and a principal's requests do not spend the failed allowance", async () => {
    process.env.AUTH_TRUST_PROXY = "1";
    signInAs(tenantMember("VIEWER", "t1", "limited-user-5"));
    for (let i = 0; i < 100; i += 1) await call("entity.read", {}, RATE);
    expect((await call("entity.read", {}, RATE)).status).toBe(429);
    signedOut();
    // the same caller, now not authenticated, still has its own (failed) allowance: 401, not 429
    expect((await call("entity.read", { "x-forwarded-for": "203.0.113.60" }, RATE)).status).toBe(401);
  });

  it("a route without rateLimit is not limited at all (the app's own endpoints keep their behaviour)", async () => {
    signInAs(tenantMember("VIEWER", "t1", "limited-user-6"));
    for (let i = 0; i < 150; i += 1) expect((await call("entity.read")).status).toBe(200);
    signedOut();
    for (let i = 0; i < 30; i += 1) expect((await call("entity.read")).status).toBe(401);
  });

  it("the rate limit comes after the credential and before the policy: a refused caller's requests are counted too", async () => {
    signInAs(roleless("limited-user-7"));
    for (let i = 0; i < 100; i += 1) expect((await call("entity.read", {}, RATE)).status).toBe(404);
    expect((await call("entity.read", {}, RATE)).status).toBe(429);
  });

  it("the route's own answer to a caller with no credential (unauthenticated) is not a refusal: it is never counted, so it is never a 429", async () => {
    process.env.AUTH_TRUST_PROXY = "1";
    signedOut();
    const from = { "x-forwarded-for": "203.0.113.70" };
    const constant = { rateLimit: true, unauthenticated: () => new Response("0", { status: 200 }) } as const;
    // far more than the 20 a minute of failed requests: every one is the route's constant answer
    for (let i = 0; i < 40; i += 1) expect((await call("entity.read", from, constant)).status, String(i + 1)).toBe(200);
    // a request the route does not answer is still counted, from the same address: its 21st is the 429
    for (let i = 0; i < 20; i += 1) expect((await call("entity.read", from, RATE)).status).toBe(401);
    expect((await call("entity.read", from, RATE)).status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a route can write its refusal in its own shape (respondLimited): the 429 carries that body and Retry-After", async () => {
    signInAs(tenantMember("VIEWER", "t1", "limited-user-8"));
    const own = {
      rateLimit: true,
      respondLimited: ({ retryAfterSeconds }: { retryAfterSeconds: number }) =>
        Response.json({ error: "slow down" }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }),
    } as const;
    for (let i = 0; i < 100; i += 1) await call("entity.read", {}, own);
    const limited = await call("entity.read", {}, own);
    expect(limited.status).toBe(429);
    expect(await bodyOf(limited)).toEqual({ error: "slow down" });
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
