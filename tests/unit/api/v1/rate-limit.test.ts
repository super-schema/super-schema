// @vitest-environment node
/**
 * The REST API's limits (src/app/api/v1/rate-limit.ts), KD-028, as `withApiAuth` applies them (`rateLimit: true`, tests/unit/lib/access/api.test.ts):
 *  - an AUTHENTICATED request counts against its PRINCIPAL (the API key's service principal, or the signed-in user), 100 a minute by default;
 *    `API_RATE_LIMIT_PER_MINUTE` sets another whole number;
 *  - a request that does NOT authenticate counts against its CLIENT ADDRESS, 20 a minute, in an allowance of its own that refuses nothing else;
 *  - the address is the proxy's word only when AUTH_TRUST_PROXY=1 (the same switch as the sign-in throttle): without one there is no client address,
 *    and every failed request shares one allowance, which says so rather than pretending to tell the callers apart;
 *  - the 429 is written in the API's own envelope, with the headers a client reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { FAILED_AUTH_LIMIT_PER_MINUTE, PRINCIPAL_LIMIT_PER_MINUTE, checkFailedAuthRateLimit, checkPrincipalRateLimit, principalLimitPerMinute } from "@/app/api/v1/rate-limit";

const SAVED = { ...process.env };
let counter = 0;
/** A request from an address nobody else in the file uses (the limiter keeps its state for the life of the module). */
const from = (forwarded?: string) => new Request("http://localhost/api/v1/x", { headers: forwarded ? { "x-forwarded-for": forwarded } : {} });
const fresh = () => `10.99.${Math.floor(counter / 250)}.${(counter++ % 250) + 1}`;
/** A principal nobody else in the file uses. */
const principal = () => ({ userId: `user-${counter++}` });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
  // Each test gets a window of its own: the previous one has long expired.
  vi.setSystemTime(Date.now() + counter * 120_000);
});
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...SAVED };
});

describe("the principal allowance (an authenticated request)", () => {
  it("is 100 requests a minute for one principal; the 101st is a 429 in the API's envelope", () => {
    const p = principal();
    for (let i = 0; i < PRINCIPAL_LIMIT_PER_MINUTE; i += 1) expect(checkPrincipalRateLimit(p, {}), String(i)).toBeNull();
    expect(checkPrincipalRateLimit(p, {})?.status).toBe(429);
  });

  it("is not shared between principals: another one is not limited by it", () => {
    const a = principal();
    const b = principal();
    for (let i = 0; i < PRINCIPAL_LIMIT_PER_MINUTE + 1; i += 1) checkPrincipalRateLimit(a, {});
    expect(checkPrincipalRateLimit(a, {})?.status).toBe(429);
    expect(checkPrincipalRateLimit(b, {})).toBeNull();
  });

  it("is not spent by a failed request, which counts against an address (its own allowance) and never against a principal", () => {
    const p = principal();
    process.env.AUTH_TRUST_PROXY = "1";
    const address = fresh();
    for (let i = 0; i < FAILED_AUTH_LIMIT_PER_MINUTE + 1; i += 1) checkFailedAuthRateLimit(from(address));
    expect(checkFailedAuthRateLimit(from(address))?.status).toBe(429);
    // the principal has its whole allowance left
    for (let i = 0; i < PRINCIPAL_LIMIT_PER_MINUTE; i += 1) expect(checkPrincipalRateLimit(p, {})).toBeNull();
  });

  it("the allowance comes back when the window is over", () => {
    const p = principal();
    for (let i = 0; i < PRINCIPAL_LIMIT_PER_MINUTE + 1; i += 1) checkPrincipalRateLimit(p, {});
    expect(checkPrincipalRateLimit(p, {})?.status).toBe(429);
    vi.setSystemTime(Date.now() + 61_000);
    expect(checkPrincipalRateLimit(p, {})).toBeNull();
  });

  it("API_RATE_LIMIT_PER_MINUTE sets the number when it is a positive whole number; anything else is the default", () => {
    expect(principalLimitPerMinute({ API_RATE_LIMIT_PER_MINUTE: "3" })).toBe(3);
    expect(principalLimitPerMinute({ API_RATE_LIMIT_PER_MINUTE: " 250 " })).toBe(250);
    for (const value of ["", "   ", "0", "-5", "2.5", "1e3", "lots", "07"]) {
      expect(principalLimitPerMinute({ API_RATE_LIMIT_PER_MINUTE: value }), JSON.stringify(value)).toBe(PRINCIPAL_LIMIT_PER_MINUTE);
    }
    expect(principalLimitPerMinute({})).toBe(PRINCIPAL_LIMIT_PER_MINUTE);

    const p = principal();
    const env = { API_RATE_LIMIT_PER_MINUTE: "3" };
    expect([1, 2, 3].map(() => checkPrincipalRateLimit(p, env))).toEqual([null, null, null]);
    expect(checkPrincipalRateLimit(p, env)?.status).toBe(429);
  });
});

describe("the failed-authentication allowance (a request that does not authenticate)", () => {
  it("behind a trusted proxy each address has its own 20 a minute; the 21st from it is a 429", () => {
    process.env.AUTH_TRUST_PROXY = "1";
    const a = fresh();
    const b = fresh();
    for (let i = 0; i < FAILED_AUTH_LIMIT_PER_MINUTE; i += 1) expect(checkFailedAuthRateLimit(from(a)), String(i)).toBeNull();
    expect(checkFailedAuthRateLimit(from(a))?.status).toBe(429);
    expect(checkFailedAuthRateLimit(from(b))).toBeNull();
  });

  it("with no trusted proxy the header counts for nothing: every failed request is one shared allowance, whatever address it claims", () => {
    delete process.env.AUTH_TRUST_PROXY;
    for (let i = 0; i < FAILED_AUTH_LIMIT_PER_MINUTE; i += 1) expect(checkFailedAuthRateLimit(from(fresh()))).toBeNull();
    // twenty made-up addresses used up the one allowance, and a request with no address at all is in it too
    expect(checkFailedAuthRateLimit(from(fresh()))?.status).toBe(429);
    expect(checkFailedAuthRateLimit(from())?.status).toBe(429);
  });

  it("only exactly 1 trusts the proxy (anything else is untrusted), and a header that is not an address makes no bucket of its own", () => {
    process.env.AUTH_TRUST_PROXY = "true";
    for (let i = 0; i < FAILED_AUTH_LIMIT_PER_MINUTE; i += 1) checkFailedAuthRateLimit(from(fresh()));
    expect(checkFailedAuthRateLimit(from(fresh()))?.status).toBe(429);
    vi.setSystemTime(Date.now() + 120_000);
    process.env.AUTH_TRUST_PROXY = "1";
    for (let i = 0; i < FAILED_AUTH_LIMIT_PER_MINUTE; i += 1) checkFailedAuthRateLimit(from("not-an-address"));
    expect(checkFailedAuthRateLimit(from("another-garbage"))?.status).toBe(429);
  });

  it("with trust on and no proxy in front the socket's own loopback address (what next start writes into the header) is the one shared allowance, not a client", () => {
    process.env.AUTH_TRUST_PROXY = "1";
    for (let i = 0; i < FAILED_AUTH_LIMIT_PER_MINUTE; i += 1) expect(checkFailedAuthRateLimit(from(["127.0.0.1", "::1", "::ffff:127.0.0.1"][i % 3])), String(i)).toBeNull();
    expect(checkFailedAuthRateLimit(from("127.0.0.1"))?.status).toBe(429);
    expect(checkFailedAuthRateLimit(from())?.status).toBe(429);
    // a real client address next to them is not limited by it
    expect(checkFailedAuthRateLimit(from(fresh()))).toBeNull();
  });

  it("refuses nothing but failures: an exhausted failed-authentication allowance does not touch any principal", () => {
    delete process.env.AUTH_TRUST_PROXY;
    for (let i = 0; i < FAILED_AUTH_LIMIT_PER_MINUTE + 1; i += 1) checkFailedAuthRateLimit(from());
    expect(checkFailedAuthRateLimit(from())?.status).toBe(429);
    expect(checkPrincipalRateLimit(principal(), {})).toBeNull();
  });
});

describe("the 429 answer", () => {
  it("is the API's envelope with the retry hint in details, and the headers a client reads (the allowance's own numbers)", async () => {
    process.env.AUTH_TRUST_PROXY = "1";
    const a = fresh();
    for (let i = 0; i < FAILED_AUTH_LIMIT_PER_MINUTE; i += 1) checkFailedAuthRateLimit(from(a));
    const limited = checkFailedAuthRateLimit(from(a));
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("content-type")).toMatch(/application\/json/);
    expect(limited?.headers.get("x-ratelimit-limit")).toBe(String(FAILED_AUTH_LIMIT_PER_MINUTE));
    expect(limited?.headers.get("x-ratelimit-remaining")).toBe("0");
    const retryAfter = Number(limited?.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(Number(limited?.headers.get("x-ratelimit-reset"))).toBeGreaterThan(Date.now() / 1000 - 5);
    const body = JSON.parse((await limited?.text()) ?? "");
    expect(body).toEqual({
      success: false,
      error: { code: "RATE_LIMITED", message: expect.stringMatching(/^Rate limit exceeded\. Try again in \d+ seconds\.$/), details: { retryAfter }, suggestedFix: expect.any(String) },
    });
  });

  it("for a principal says the principal's number", () => {
    const p = principal();
    const env = { API_RATE_LIMIT_PER_MINUTE: "2" };
    checkPrincipalRateLimit(p, env);
    checkPrincipalRateLimit(p, env);
    expect(checkPrincipalRateLimit(p, env)?.headers.get("x-ratelimit-limit")).toBe("2");
  });
});
