// @vitest-environment node
/**
 * The REST API's rate limit (src/app/api/v1/rate-limit.ts), KD-028:
 *  - the client address is the PROXY's word, not the client's: `X-Forwarded-For` counts only when AUTH_TRUST_PROXY=1 (the same switch as the sign-in
 *    throttle); otherwise every caller is one client, so inventing a header never buys a fresh allowance;
 *  - the 429 is written in the API's own envelope, `{ success: false, error: { code, message, details } }`, with the headers a client reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { checkRateLimit } from "@/app/api/v1/rate-limit";

const SAVED = { ...process.env };
let counter = 0;
/** A request from an address nobody else in the file uses (the limiter keeps its state for the life of the module). */
const from = (forwarded?: string) => new Request("http://localhost/api/v1/x", { headers: forwarded ? { "x-forwarded-for": forwarded } : {} });
const fresh = () => `10.99.${Math.floor(counter / 250)}.${(counter++ % 250) + 1}`;

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

describe("the client address", () => {
  it("behind a trusted proxy, each address has its own allowance of 100 a minute", () => {
    process.env.AUTH_TRUST_PROXY = "1";
    const a = fresh();
    const b = fresh();
    for (let i = 0; i < 100; i += 1) expect(checkRateLimit(from(a))).toBeNull();
    expect(checkRateLimit(from(a))?.status).toBe(429);
    expect(checkRateLimit(from(b))).toBeNull();
  });

  it("with no trusted proxy the header counts for nothing: every caller is one client, so another value is no fresh allowance (KD-028)", () => {
    delete process.env.AUTH_TRUST_PROXY;
    for (let i = 0; i < 100; i += 1) expect(checkRateLimit(from(fresh()))).toBeNull();
    // a hundred requests with a hundred different made-up addresses used up the one allowance
    expect(checkRateLimit(from(fresh()))?.status).toBe(429);
    expect(checkRateLimit(from())?.status).toBe(429);
  });

  it("only exactly 1 trusts the proxy (anything else is untrusted), and a header that is not an address makes no bucket of its own", () => {
    process.env.AUTH_TRUST_PROXY = "true";
    for (let i = 0; i < 100; i += 1) checkRateLimit(from(fresh()));
    expect(checkRateLimit(from(fresh()))?.status).toBe(429);
    vi.setSystemTime(Date.now() + 120_000);
    process.env.AUTH_TRUST_PROXY = "1";
    for (let i = 0; i < 100; i += 1) checkRateLimit(from("not-an-address"));
    expect(checkRateLimit(from("another-garbage"))?.status).toBe(429);
  });

  it("with trust on and no proxy in front the socket's own loopback address (what next start writes into the header) is the one shared bucket, not a client", () => {
    process.env.AUTH_TRUST_PROXY = "1";
    for (let i = 0; i < 100; i += 1) expect(checkRateLimit(from(["127.0.0.1", "::1", "::ffff:127.0.0.1"][i % 3])), String(i)).toBeNull();
    // the three spellings and a request with no header at all used up one allowance together
    expect(checkRateLimit(from("127.0.0.1"))?.status).toBe(429);
    expect(checkRateLimit(from())?.status).toBe(429);
    // a real client address next to them is not limited by it
    expect(checkRateLimit(from(fresh()))).toBeNull();
  });

  it("the allowance comes back when the window is over", () => {
    process.env.AUTH_TRUST_PROXY = "1";
    const a = fresh();
    for (let i = 0; i < 101; i += 1) checkRateLimit(from(a));
    expect(checkRateLimit(from(a))?.status).toBe(429);
    vi.setSystemTime(Date.now() + 61_000);
    expect(checkRateLimit(from(a))).toBeNull();
  });
});

describe("the 429 answer", () => {
  it("is the API's envelope with the retry hint in details, and the headers a client reads", async () => {
    process.env.AUTH_TRUST_PROXY = "1";
    const a = fresh();
    for (let i = 0; i < 100; i += 1) checkRateLimit(from(a));
    const limited = checkRateLimit(from(a));
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("content-type")).toMatch(/application\/json/);
    expect(limited?.headers.get("x-ratelimit-limit")).toBe("100");
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
});
